import { scaffold } from '../agents/scaffold.js';
import { review } from '../agents/review/index.js';
import { test } from '../agents/test.js';
import { cicd } from '../agents/cicd.js';
import { planner } from '../agents/planner.js';
import { clarifier } from '../agents/clarifier.js';
import { randomUUID } from 'crypto';
import type { RunResult } from '../lib/runner.js';

export interface SpecOptions {
  steps?: Set<string>;
  iterations?: number;
  triggerSource?: string;
}

export interface StepResult { runId: string; durationMs: number; status: string; }

export interface SpecResult {
  workflowRunId: string;
  steps: Record<string, StepResult>;
  totalDurationMs: number;
}

const STEP_ORDER = ['clarifier', 'planner', 'scaffold', 'test', 'review', 'cicd'];

export async function runSpec(specContent: string, opts: SpecOptions = {}): Promise<SpecResult> {
  const workflowRunId = randomUUID();
  const steps = opts.steps ?? new Set(STEP_ORDER);
  const iterations = opts.iterations ?? 1;
  const start = Date.now();
  const results: Record<string, StepResult> = {};

  const runOpts = { workflowRunId, triggerSource: opts.triggerSource ?? 'cli' };
  const agents: Record<string, (input: string, opts: any) => Promise<RunResult>> = {
    clarifier, planner, scaffold, test, review, cicd,
  };

  let input = specContent;

  for (let iter = 0; iter < iterations; iter++) {
    for (const step of STEP_ORDER) {
      if (!steps.has(step)) continue;
      const agent = agents[step];
      const r = await agent(input, runOpts);
      results[step] = { runId: r.runId, durationMs: r.durationMs, status: 'DONE' };
      if (step === 'planner' && r.output) input = r.output;
      if (step === 'review' && r.output.includes('[VERDICT: SHIP]')) break;
    }
  }

  return { workflowRunId, steps: results, totalDurationMs: Date.now() - start };
}
