import { query, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { insertRun, updateRun } from '../store/runs.js';
import { costGuard } from './cost-guard.js';
import { circuitBreaker } from './circuit-breaker.js';
import { log } from './logger.js';
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

  try {
    const tools = opts.tools ?? ['Read', 'Write', 'Bash'];
    const hasSubagents = opts.subagents && Object.keys(opts.subagents).length > 0;
    const allTools = hasSubagents ? [...tools, 'Agent'] : tools;

    for await (const msg of query({
      prompt: opts.prompt,
      options: {
        allowedTools: allTools,
        permissionMode: 'bypassPermissions',
        cwd,
        ...(hasSubagents ? { agents: opts.subagents } : {}),
      },
    })) {
      const m = msg as any;

      if (m.type === 'rate_limit_event') {
        const info = m.rate_limit_info;
        if (info?.status === 'rejected') {
          if (info.resetsAt != null) {
            circuitBreaker.openUntil(info.resetsAt);
            log.warn({ resetsAt: info.resetsAt, rateLimitType: info.rateLimitType }, 'Rate limit rejected — circuit opened');
          } else {
            circuitBreaker.openForFallback();
            log.warn({}, 'Rate limit rejected (no resetsAt) — circuit opened with fallback');
          }
        }
        continue;
      }

      if (m.type === 'system' && m.subtype === 'api_retry' && m.error_status === 429) {
        if (m.retry_delay_ms != null) {
          circuitBreaker.openUntil(Date.now() + m.retry_delay_ms);
          log.warn({ retry_delay_ms: m.retry_delay_ms }, '429 retry — circuit opened');
        } else {
          circuitBreaker.openForFallback();
          log.warn({}, '429 retry (no delay) — circuit opened with fallback');
        }
        continue;
      }

      if (m.type === 'result') {
        output = m.result ?? '';
        tokensIn = m.usage?.input_tokens ?? 0;
        tokensOut = m.usage?.output_tokens ?? 0;
        costGuard.recordRun();
      }
    }

    const durationMs = Date.now() - start;
    updateRun(runId, { output, tokensIn, tokensOut, status: 'DONE', durationMs });
    log.info({ agent: opts.name, tokensIn, tokensOut, durationMs }, 'Agent done');
    return { runId, output, tokensIn, tokensOut, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    updateRun(runId, { output: `ERROR: ${msg}`, status: 'FAILED', durationMs });
    log.error({ agent: opts.name, err: msg }, 'Agent failed');
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
