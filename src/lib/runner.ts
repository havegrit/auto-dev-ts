import { type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { getAgentRunner } from '../llm/registry.js';
import type { AgentEvent } from '../llm/types.js';
import { insertRun, updateRun } from '../store/runs.js';
import { costGuard } from './cost-guard.js';
import { circuitBreaker } from './circuit-breaker.js';
import { modelConfig } from './model-config.js';
import { log } from './logger.js';
import { emitRunEvent, closeEmitter } from './run-events.js';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';

export interface RunOptions {
  name: string;
  prompt: string;
  cwd?: string;
  triggerSource?: string;
  triggerDetail?: string;
  workflowRunId?: string;
  subagents?: Record<string, AgentDefinition>;
  tools?: string[];
}

export interface RunResult {
  runId: string;
  output: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

const DEFAULT_WORKSPACE = process.env.AUTO_DEV_WORKSPACE_ROOT ?? './data/workspace';

async function _execute(runId: string, opts: RunOptions): Promise<RunResult> {
  const start = Date.now();
  const cwd = opts.cwd ?? DEFAULT_WORKSPACE;
  let output = '';
  let tokensIn = 0;
  let tokensOut = 0;
  const ctx = { runId, agent: opts.name };

  try {
    // 기본값은 읽기 전용. 구현 권한(Write/Bash)은 호출부가 명시적으로 부여해야 한다
    // (역할 경계는 src/agents/specs.ts 의 AGENT_SPECS 가 단일 출처).
    const tools = opts.tools ?? ['Read'];
    const now = () => new Date().toISOString();

    const onEvent = (e: AgentEvent) => {
      if (e.kind === 'text') {
        emitRunEvent(runId, { type: 'text', ts: now(), data: e.text.slice(0, 500) });
      } else if (e.kind === 'tool_call') {
        emitRunEvent(runId, { type: 'tool_call', ts: now(), data: `${e.name}(${e.input.slice(0, 200)})` });
      } else if (e.kind === 'tool_result') {
        emitRunEvent(runId, { type: 'tool_result', ts: now(), data: e.content.slice(0, 200) });
      } else if (e.kind === 'rate_limit') {
        if (e.resetsAt != null) {
          circuitBreaker.openUntil(e.resetsAt);
          log.warn({ ...ctx, resetsAt: e.resetsAt }, 'Rate limit — circuit opened');
        } else if (e.retryDelayMs != null) {
          circuitBreaker.openUntil(Date.now() + e.retryDelayMs);
          log.warn({ ...ctx, retryDelayMs: e.retryDelayMs }, '429 retry — circuit opened');
        } else {
          circuitBreaker.openForFallback();
          log.warn(ctx, 'Rate limit (no reset) — circuit opened with fallback');
        }
      }
    };

    const outcome = await getAgentRunner().run(
      { prompt: opts.prompt, cwd, tools, subagents: opts.subagents, model: modelConfig.getModel(), effort: modelConfig.getEffortOption() },
      onEvent,
    );

    const durationMs = Date.now() - start;
    if (outcome.status === 'success') {
      output = outcome.output;
      tokensIn = outcome.tokensIn;
      tokensOut = outcome.tokensOut;
      costGuard.recordRun();
      updateRun(runId, { output, tokensIn, tokensOut, status: 'DONE', durationMs, stopReason: outcome.stopReason ?? undefined, numTurns: outcome.numTurns });
      log.info({ ...ctx, tokensIn, tokensOut, durationMs, numTurns: outcome.numTurns, stopReason: outcome.stopReason }, 'Agent done');
      emitRunEvent(runId, { type: 'status', ts: now(), data: 'DONE' });
      closeEmitter(runId);
      return { runId, output, tokensIn, tokensOut, durationMs };
    } else {
      output = outcome.output;
      tokensIn = outcome.tokensIn;
      tokensOut = outcome.tokensOut;
      updateRun(runId, { output, tokensIn, tokensOut, status: 'FAILED', durationMs, errorType: outcome.errorType, stopReason: outcome.stopReason ?? undefined, numTurns: outcome.numTurns });
      log.error({ ...ctx, errorType: outcome.errorType, permDenials: outcome.permissionDenials, errors: outcome.errors, numTurns: outcome.numTurns, stopReason: outcome.stopReason, durationMs }, 'Agent result error');
      emitRunEvent(runId, { type: 'status', ts: now(), data: `FAILED:${outcome.errorType}` });
      closeEmitter(runId);
      return { runId, output, tokensIn, tokensOut, durationMs };
    }
  } catch (err) {
    const durationMs = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : undefined;
    output = `ERROR: ${errMsg}`;
    updateRun(runId, { output, status: 'FAILED', durationMs, errorType: 'exception' });
    log.error({ ...ctx, durationMs, err: errMsg, stack: errStack }, 'Agent threw exception');
    emitRunEvent(runId, { type: 'status', ts: new Date().toISOString(), data: `FAILED:exception:${errMsg}` });
    closeEmitter(runId);
    throw err;
  }
}

type BlockReason = 'cost_guard' | 'circuit_breaker';

function _initRun(opts: RunOptions): { runId: string; blocked: false } | { runId: string; blocked: true; reason: BlockReason; blockedOutput: string } {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const cwd = opts.cwd ?? DEFAULT_WORKSPACE;
  mkdirSync(cwd, { recursive: true });

  const common = {
    id: runId, agentName: opts.name, input: opts.prompt,
    status: 'BLOCKED' as const, startedAt, durationMs: 0,
    triggerSource: opts.triggerSource, triggerDetail: opts.triggerDetail,
    workflowRunId: opts.workflowRunId,
  };

  if (circuitBreaker.isOpen()) {
    const { openUntil } = circuitBreaker.stats();
    const blockedOutput = `Rate limit in effect. Circuit open until ${openUntil}.`;
    insertRun({ ...common, output: blockedOutput });
    log.warn({ agent: opts.name, openUntil }, 'Blocked: circuit breaker open');
    return { runId, blocked: true, reason: 'circuit_breaker', blockedOutput };
  }

  if (!costGuard.allow()) {
    const blockedOutput = 'Daily run limit exceeded.';
    insertRun({ ...common, output: blockedOutput });
    log.warn({ agent: opts.name }, 'Blocked: daily run limit exceeded');
    return { runId, blocked: true, reason: 'cost_guard', blockedOutput };
  }

  insertRun({
    id: runId, agentName: opts.name, input: opts.prompt,
    status: 'RUNNING', startedAt,
    triggerSource: opts.triggerSource, triggerDetail: opts.triggerDetail,
    workflowRunId: opts.workflowRunId,
  });
  return { runId, blocked: false };
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const init = _initRun(opts);
  if (init.blocked) {
    return { runId: init.runId, output: init.blockedOutput, tokensIn: 0, tokensOut: 0, durationMs: 0 };
  }
  return _execute(init.runId, opts);
}

export function runAgentBackground(opts: RunOptions): string {
  const init = _initRun(opts);
  if (!init.blocked) {
    _execute(init.runId, opts).catch(() => {});
  }
  return init.runId;
}
