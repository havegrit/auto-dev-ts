import { query } from '@anthropic-ai/claude-agent-sdk';
import { insertRun, updateRun } from '../store/runs.js';
import { costGuard } from './cost-guard.js';
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
  subagents?: Array<{ name: string; description: string }>;
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

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const cwd = opts.cwd ?? DEFAULT_WORKSPACE;
  mkdirSync(cwd, { recursive: true });

  if (!costGuard.allow()) {
    insertRun({ id: runId, agentName: opts.name, input: opts.prompt, output: 'Daily run limit exceeded.', status: 'BLOCKED', startedAt, durationMs: 0, triggerSource: opts.triggerSource, triggerDetail: opts.triggerDetail, workflowRunId: opts.workflowRunId });
    log.warn({ agent: opts.name }, 'Blocked: daily run limit exceeded');
    return { runId, output: 'Daily run limit exceeded.', tokensIn: 0, tokensOut: 0, durationMs: 0 };
  }

  insertRun({ id: runId, agentName: opts.name, input: opts.prompt, status: 'RUNNING', startedAt, triggerSource: opts.triggerSource, triggerDetail: opts.triggerDetail, workflowRunId: opts.workflowRunId });

  const start = Date.now();
  let output = '';
  let tokensIn = 0;
  let tokensOut = 0;

  try {
    const tools = opts.tools ?? ['Read', 'Write', 'Bash'];
    const allTools = opts.subagents?.length ? [...tools, 'Agent'] : tools;

    for await (const msg of query(opts.prompt, {
      allowedTools: allTools,
      permissionMode: 'bypassPermissions',
      cwd,
      ...(opts.subagents?.length ? { agents: opts.subagents } : {}),
    } as any)) {
      if ((msg as any).type === 'result') {
        output = (msg as any).result ?? '';
        tokensIn = (msg as any).usage?.input_tokens ?? 0;
        tokensOut = (msg as any).usage?.output_tokens ?? 0;
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
