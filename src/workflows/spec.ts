import { scaffold } from '../agents/scaffold.js';
import { review } from '../agents/review/index.js';
import { test } from '../agents/test.js';
import { cicd } from '../agents/cicd.js';
import { planner } from '../agents/planner.js';
import { clarifier } from '../agents/clarifier.js';
import { randomUUID } from 'crypto';
import type { RunResult } from '../lib/runner.js';
import { insertRun, updateRun } from '../store/runs.js';

export interface SpecOptions {
  steps?: Set<string>;
  iterations?: number;
  triggerSource?: string;
  triggerDetail?: string;
  workflowRunId?: string;
}

export interface StepResult { runId: string; durationMs: number; status: string; }

export interface SpecResult {
  workflowRunId: string;
  steps: Record<string, StepResult>;
  totalDurationMs: number;
  verdict?: string;
}

const STEP_ORDER = ['clarifier', 'planner', 'scaffold', 'test', 'review', 'cicd'];

export async function runSpec(specContent: string, opts: SpecOptions = {}): Promise<SpecResult> {
  const workflowRunId = opts.workflowRunId ?? randomUUID();
  const steps = opts.steps ?? new Set(STEP_ORDER);
  const iterations = opts.iterations ?? 1;
  const start = Date.now();
  const results: Record<string, StepResult> = {};

  const runOpts = { workflowRunId, triggerSource: opts.triggerSource ?? 'cli' };
  const agents: Record<string, (input: string, opts: any) => Promise<RunResult>> = {
    clarifier, planner, scaffold, test, review, cicd,
  };

  let input = specContent;
  let verdict: string | undefined;

  for (let iter = 0; iter < iterations; iter++) {
    for (const step of STEP_ORDER) {
      if (!steps.has(step)) continue;
      const agent = agents[step];
      const r = await agent(input, runOpts);
      results[step] = { runId: r.runId, durationMs: r.durationMs, status: 'DONE' };
      if (step === 'planner' && r.output) input = r.output;
      if (step === 'review') {
        verdict = r.output.includes('[VERDICT: SHIP]') ? 'SHIP' : 'NEEDS_WORK';
        if (verdict === 'SHIP') break;
      }
    }
  }

  return { workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict };
}

export function runSpecBackground(specContent: string, opts: SpecOptions = {}): string {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  insertRun({
    id: runId,
    agentName: 'spec',
    input: specContent.slice(0, 4000),
    status: 'RUNNING',
    startedAt,
    triggerSource: opts.triggerSource ?? 'dashboard',
  });

  const wallStart = Date.now();
  runSpec(specContent, { ...opts, workflowRunId: runId }).then(result => {
    const summary = Object.entries(result.steps)
      .map(([k, v]) => `${k}: ${v.status}`)
      .join(', ');
    updateRun(runId, { output: summary, status: 'DONE', durationMs: result.totalDurationMs });
  }).catch(err => {
    updateRun(runId, {
      output: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      status: 'FAILED',
      durationMs: Date.now() - wallStart,
    });
  });

  return runId;
}
