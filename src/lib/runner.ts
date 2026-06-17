import { query, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
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
    const hasSubagents = opts.subagents && Object.keys(opts.subagents).length > 0;
    const allTools = hasSubagents ? [...tools, 'Agent'] : tools;

    for await (const msg of query({
      prompt: opts.prompt,
      options: {
        allowedTools: allTools,
        permissionMode: 'bypassPermissions',
        cwd,
        model: modelConfig.getModel(),
        ...(modelConfig.getEffortOption() !== undefined ? { effort: modelConfig.getEffortOption() } : {}),
        ...(hasSubagents ? { agents: opts.subagents } : {}),
      },
    })) {
      const m = msg as any;

      const now = () => new Date().toISOString();

      if (m.type === 'assistant') {
        for (const block of (m.message?.content ?? [])) {
          if (block.type === 'text' && block.text?.trim()) {
            emitRunEvent(runId, { type: 'text', ts: now(), data: block.text.trim().slice(0, 500) });
          } else if (block.type === 'tool_use') {
            const input = typeof block.input === 'object'
              ? JSON.stringify(block.input).slice(0, 200)
              : String(block.input ?? '');
            emitRunEvent(runId, { type: 'tool_call', ts: now(), data: `${block.name}(${input})` });
          }
        }
        continue;
      }

      if (m.type === 'tool_result') {
        const content = Array.isArray(m.content)
          ? m.content.map((c: any) => c.text ?? '').join('').slice(0, 200)
          : String(m.content ?? '').slice(0, 200);
        if (content.trim()) {
          emitRunEvent(runId, { type: 'tool_result', ts: now(), data: content });
        }
        continue;
      }

      if (m.type === 'rate_limit_event') {
        const info = m.rate_limit_info;
        if (info?.status === 'rejected') {
          if (info.resetsAt != null) {
            circuitBreaker.openUntil(info.resetsAt);
            log.warn({ ...ctx, resetsAt: info.resetsAt, rateLimitType: info.rateLimitType }, 'Rate limit rejected — circuit opened');
          } else {
            circuitBreaker.openForFallback();
            log.warn(ctx, 'Rate limit rejected (no resetsAt) — circuit opened with fallback');
          }
        }
        continue;
      }

      if (m.type === 'system' && m.subtype === 'api_retry' && m.error_status === 429) {
        if (m.retry_delay_ms != null) {
          circuitBreaker.openUntil(Date.now() + m.retry_delay_ms);
          log.warn({ ...ctx, retry_delay_ms: m.retry_delay_ms }, '429 retry — circuit opened');
        } else {
          circuitBreaker.openForFallback();
          log.warn(ctx, '429 retry (no delay) — circuit opened with fallback');
        }
        continue;
      }

      if (m.type === 'result') {
        tokensIn = m.usage?.input_tokens ?? 0;
        tokensOut = m.usage?.output_tokens ?? 0;
        const numTurns: number = m.num_turns ?? 0;
        const stopReason: string | null = m.stop_reason ?? null;

        if (m.subtype === 'success') {
          output = m.result ?? '';
          costGuard.recordRun();
          const durationMs = Date.now() - start;
          updateRun(runId, { output, tokensIn, tokensOut, status: 'DONE', durationMs, stopReason: stopReason ?? undefined, numTurns });
          log.info({ ...ctx, tokensIn, tokensOut, durationMs, numTurns, stopReason }, 'Agent done');
          emitRunEvent(runId, { type: 'status', ts: new Date().toISOString(), data: 'DONE' });
          closeEmitter(runId);
          return { runId, output, tokensIn, tokensOut, durationMs };
        } else {
          // error subtype: error_during_execution | error_max_turns | error_max_budget_usd | ...
          const errorType: string = m.subtype ?? 'error_unknown';
          const errors: string[] = Array.isArray(m.errors) ? m.errors : [];
          const permDenials: string[] = (m.permission_denials ?? []).map((d: any) => d.tool_name ?? String(d));
          output = [
            `[${errorType}]`,
            errors.length > 0 ? errors.join('\n') : '',
            permDenials.length > 0 ? `Permission denied: ${permDenials.join(', ')}` : '',
          ].filter(Boolean).join('\n');

          const durationMs = Date.now() - start;
          updateRun(runId, { output, tokensIn, tokensOut, status: 'FAILED', durationMs, errorType, stopReason: stopReason ?? undefined, numTurns });
          log.error({ ...ctx, errorType, errors, permDenials, numTurns, stopReason, durationMs }, 'Agent result error');
          emitRunEvent(runId, { type: 'status', ts: new Date().toISOString(), data: `FAILED:${errorType}` });
          closeEmitter(runId);
          return { runId, output, tokensIn, tokensOut, durationMs };
        }
      }
    }

    // 스트림이 result 없이 종료된 경우
    const durationMs = Date.now() - start;
    output = '[no result] Stream ended without a result message';
    updateRun(runId, { output, status: 'FAILED', durationMs, errorType: 'no_result' });
    log.error({ ...ctx, durationMs }, 'Stream ended without result');
    emitRunEvent(runId, { type: 'status', ts: new Date().toISOString(), data: 'FAILED:no_result' });
    closeEmitter(runId);
    return { runId, output, tokensIn, tokensOut, durationMs };
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
