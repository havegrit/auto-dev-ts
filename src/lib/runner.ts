import { type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { getAgentRunner } from '../llm/registry.js';
import type { AgentEvent } from '../llm/types.js';
import { insertRun, updateRun } from '../store/runs.js';
import { costGuard } from './cost-guard.js';
import { circuitBreaker } from './circuit-breaker.js';
import { modelConfig } from './model-config.js';
import { log } from './logger.js';
import { emitRunEvent, closeEmitter } from './run-events.js';
import { expandHome } from './workspace.js';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import type { AgentRunOutcome } from '../llm/types.js';
import { registerRunCancellation } from './run-cancellation.js';

export interface RunOptions {
  name: string;
  prompt: string;
  cwd?: string;
  triggerSource?: string;
  triggerDetail?: string;
  workflowRunId?: string;
  subagents?: Record<string, AgentDefinition>;
  tools?: string[];
  signal?: AbortSignal;
}

export interface RunResult {
  runId: string;
  output: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  status: 'DONE' | 'FAILED' | 'BLOCKED' | 'CANCELLED';
}

const DEFAULT_WORKSPACE = expandHome(process.env.AUTO_DEV_WORKSPACE_ROOT ?? './data/workspace');

function clarifierOutput(outcome: AgentRunOutcome): string {
  const raw = outcome.rawOutput ?? outcome.output;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function _execute(runId: string, opts: RunOptions): Promise<RunResult> {
  const start = Date.now();
  const cwd = opts.cwd ?? DEFAULT_WORKSPACE;
  let output = '';
  let tokensIn = 0;
  let tokensOut = 0;
  const ctx = { runId, agent: opts.name };
  const abortController = new AbortController();
  const abortFromParent = () => abortController.abort(opts.signal?.reason);
  if (opts.signal?.aborted) abortFromParent();
  else opts.signal?.addEventListener('abort', abortFromParent, { once: true });
  const unregisterCancellation = registerRunCancellation(runId, abortController);

  const cancelledResult = (): RunResult => {
    const durationMs = Date.now() - start;
    output = '[cancelled] 사용자 요청으로 실행을 중단했습니다.';
    updateRun(runId, { output, status: 'FAILED', durationMs, errorType: 'user_cancelled', stopReason: 'user_cancelled' });
    log.warn({ ...ctx, durationMs }, 'Agent cancelled by user');
    emitRunEvent(runId, { type: 'status', ts: new Date().toISOString(), data: 'CANCELLED' });
    closeEmitter(runId);
    return { runId, output, tokensIn, tokensOut, durationMs, status: 'CANCELLED' };
  };

  try {
    // 기본값은 읽기 전용. 구현 권한(Write/Bash)은 호출부가 명시적으로 부여해야 한다
    // (역할 경계는 src/agents/specs.ts 의 AGENT_SPECS 가 단일 출처).
    const tools = opts.tools ?? ['Read'];
    const now = () => new Date().toISOString();
    let sawRateLimit = false;
    let suppressCircuitForFallback = false;

    const onEvent = (e: AgentEvent) => {
      if (e.kind === 'text') {
        emitRunEvent(runId, { type: 'text', ts: now(), data: e.text.slice(0, 500) });
      } else if (e.kind === 'tool_call') {
        emitRunEvent(runId, { type: 'tool_call', ts: now(), data: `${e.name}(${e.input.slice(0, 200)})` });
      } else if (e.kind === 'tool_result') {
        emitRunEvent(runId, { type: 'tool_result', ts: now(), data: e.content.slice(0, 200) });
      } else if (e.kind === 'rate_limit') {
        sawRateLimit = true;
        if (suppressCircuitForFallback) {
          log.warn({ ...ctx, resetsAt: e.resetsAt, retryDelayMs: e.retryDelayMs }, 'Rate limit — trying fallback model before opening circuit');
          return;
        }
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

    const runWithModel = async (modelId: string, model: string, effort: string | undefined): Promise<AgentRunOutcome> => {
      const providerRun = getAgentRunner(modelId).run({
        prompt: opts.prompt,
        cwd,
        tools,
        subagents: opts.subagents,
        model,
        effort,
        resultMode: opts.name === 'clarifier' ? 'raw' : 'generic',
        abortController,
      }, onEvent);
      return abortable(providerRun, abortController.signal);
    };

    const modelId = modelConfig.getModelIdForAgent(opts.name);
    const fallbackModelId = modelConfig.getFallbackModel();
    let actualModelId = modelId;
    updateRun(runId, { modelId: actualModelId });
    suppressCircuitForFallback = Boolean(fallbackModelId && fallbackModelId !== modelId);
    let outcome = await runWithModel(modelId, modelConfig.getModelForAgent(opts.name), modelConfig.getEffortOptionForAgent(opts.name));
    if (abortController.signal.aborted) return cancelledResult();
    if (sawRateLimit && fallbackModelId && fallbackModelId !== modelId) {
      log.warn({ ...ctx, modelId, fallbackModelId }, 'Primary model rate-limited — retrying fallback model');
      sawRateLimit = false;
      suppressCircuitForFallback = false;
      actualModelId = fallbackModelId;
      updateRun(runId, { modelId: actualModelId });
      outcome = await runWithModel(
        fallbackModelId,
        modelConfig.getModelForModelId(fallbackModelId),
        modelConfig.getEffortOptionForModelId(fallbackModelId),
      );
      if (abortController.signal.aborted) return cancelledResult();
    }

    const durationMs = Date.now() - start;
    if (outcome.status === 'success') {
      // clarifier output is a workflow contract ({ ready, summary, questions }), not the
      // generic Codex result contract. Preserve provider raw output so runSpec can parse it.
      output = opts.name === 'clarifier'
        ? clarifierOutput(outcome)
        : outcome.output;
      tokensIn = outcome.tokensIn;
      tokensOut = outcome.tokensOut;
      costGuard.recordRun();
      updateRun(runId, { output, tokensIn, tokensOut, status: 'DONE', durationMs, modelId: actualModelId, stopReason: outcome.stopReason ?? undefined, numTurns: outcome.numTurns });
      log.info({ ...ctx, modelId: actualModelId, tokensIn, tokensOut, durationMs, numTurns: outcome.numTurns, stopReason: outcome.stopReason }, 'Agent done');
      emitRunEvent(runId, { type: 'status', ts: now(), data: 'DONE' });
      closeEmitter(runId);
      return { runId, output, tokensIn, tokensOut, durationMs, status: 'DONE' };
    } else {
      output = outcome.output;
      tokensIn = outcome.tokensIn;
      tokensOut = outcome.tokensOut;
      updateRun(runId, { output, tokensIn, tokensOut, status: 'FAILED', durationMs, modelId: actualModelId, errorType: outcome.errorType, stopReason: outcome.stopReason ?? undefined, numTurns: outcome.numTurns });
      log.error({ ...ctx, modelId: actualModelId, errorType: outcome.errorType, permDenials: outcome.permissionDenials, errors: outcome.errors, numTurns: outcome.numTurns, stopReason: outcome.stopReason, durationMs }, 'Agent result error');
      emitRunEvent(runId, { type: 'status', ts: now(), data: `FAILED:${outcome.errorType}` });
      closeEmitter(runId);
      return { runId, output, tokensIn, tokensOut, durationMs, status: 'FAILED' };
    }
  } catch (err) {
    if (abortController.signal.aborted) return cancelledResult();
    const durationMs = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : undefined;
    output = `ERROR: ${errMsg}`;
    updateRun(runId, { output, status: 'FAILED', durationMs, errorType: 'exception' });
    log.error({ ...ctx, durationMs, err: errMsg, stack: errStack }, 'Agent threw exception');
    emitRunEvent(runId, { type: 'status', ts: new Date().toISOString(), data: `FAILED:exception:${errMsg}` });
    closeEmitter(runId);
    throw err;
  } finally {
    opts.signal?.removeEventListener('abort', abortFromParent);
    unregisterCancellation();
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
    modelId: modelConfig.getModelIdForAgent(opts.name),
  });
  return { runId, blocked: false };
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const init = _initRun(opts);
  if (init.blocked) {
    return { runId: init.runId, output: init.blockedOutput, tokensIn: 0, tokensOut: 0, durationMs: 0, status: 'BLOCKED' };
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
