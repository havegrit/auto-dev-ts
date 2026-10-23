import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  allow: true,
  modelIds: ['anthropic:sonnet'],
  fixtureValue: undefined as string | undefined,
  fixtureHead: undefined as string | undefined,
  verifyOutcomes: [] as Array<{ exitCode: number | null; timedOut: boolean; cancelled: boolean; durationMs: number; outputTail: string }>,
  verifyCalls: [] as Array<{ cwd: string; command: string; env?: Record<string, string> }>,
  harnessCopied: false,
  oracleValueAtCheck: undefined as string | undefined,
  runSpec: vi.fn(),
  runVerify: vi.fn(),
  getRunsByWorkflowId: vi.fn(),
  insertRun: vi.fn(),
  updateRun: vi.fn(),
  loadModelsFromCli: vi.fn(),
}));

vi.mock('./spec.js', () => ({ runSpec: state.runSpec }));
vi.mock('../lib/cost-guard.js', () => ({ costGuard: { allow: () => state.allow } }));
vi.mock('../lib/model-config.js', () => ({
  modelConfig: {
    getModel: () => 'anthropic:configured',
    getEffort: () => 'high',
    getFallbackModel: () => undefined,
    getAgentModels: () => ({
      clarifier: 'anthropic:configured',
      planner: 'anthropic:configured',
      scaffold: 'anthropic:configured',
      test: 'anthropic:configured',
      review: 'anthropic:configured',
      cicd: 'anthropic:configured',
    }),
    hasRunnableModel: (model: string) => state.modelIds.includes(model),
  },
  loadModelsFromCli: state.loadModelsFromCli,
}));
vi.mock('../lib/verify.js', () => ({
  runVerify: state.runVerify,
  verifyPassed: (outcome: { exitCode: number | null; timedOut: boolean; cancelled: boolean }) =>
    outcome.exitCode === 0 && !outcome.timedOut && !outcome.cancelled,
}));
vi.mock('../store/runs.js', () => ({
  getRunsByWorkflowId: state.getRunsByWorkflowId,
  insertRun: state.insertRun,
  updateRun: state.updateRun,
}));

import { runEval } from './eval.js';

describe('runEval', () => {
  const tempDirs: string[] = [];
  let root: string;
  let casesDir: string;
  let dataDir: string;
  let tempRoot: string;

  function addCase(id: string, options: {
    reproCommand?: string;
    expectedResult?: string;
    autoMergeCategory?: 'docs' | 'dependency-patch';
    oracleFiles?: Record<string, string>;
  } = {}): string {
    const dir = join(casesDir, id);
    mkdirSync(join(dir, 'fixture'), { recursive: true });
    writeFileSync(join(dir, 'spec.md'), `Implement ${id}.`);
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
      tags: ['test'],
      expectedResult: options.expectedResult ?? 'SHIP',
      ...(options.autoMergeCategory ? { autoMergeCategory: options.autoMergeCategory } : {}),
      timeoutMs: 1000,
      ...(options.reproCommand ? { reproCommand: options.reproCommand } : {}),
    }));
    writeFileSync(join(dir, 'checks.sh'), 'test -f fixture.txt\n');
    writeFileSync(join(dir, 'fixture', 'fixture.txt'), id);
    if (options.oracleFiles) {
      for (const [path, content] of Object.entries(options.oracleFiles)) {
        const fullPath = join(dir, 'oracle', path);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, content);
        const fixturePath = join(dir, 'fixture', path);
        mkdirSync(join(fixturePath, '..'), { recursive: true });
        writeFileSync(fixturePath, 'fixture version\n');
      }
    }
    return dir;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'auto-dev-eval-test-'));
    tempDirs.push(root);
    casesDir = join(root, 'cases');
    dataDir = join(root, 'data');
    tempRoot = join(root, 'tmp');
    mkdirSync(casesDir);
    mkdirSync(tempRoot);
    state.allow = true;
    state.modelIds = ['anthropic:sonnet'];
    state.verifyOutcomes = [];
    state.verifyCalls = [];
    state.harnessCopied = false;
    state.oracleValueAtCheck = undefined;
    state.fixtureValue = undefined;
    state.fixtureHead = undefined;
    state.runSpec.mockReset().mockImplementation(async (_spec: string, opts: { workflowRunId: string; cwd: string }) => {
      state.fixtureValue = readFileSync(join(opts.cwd, 'fixture.txt'), 'utf-8');
      state.fixtureHead = execFileSync('git', ['-C', opts.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      return {
        workflowRunId: opts.workflowRunId,
        steps: {},
        totalDurationMs: 25,
        verdict: 'SHIP',
        routeCount: 1,
      };
    });
    state.runVerify.mockReset().mockImplementation(async (cwd: string, config: { command: string }, options?: { env?: Record<string, string> }) => {
      state.verifyCalls.push({ cwd, command: config.command, env: options?.env });
      if (config.command.includes('checks.sh')) {
        state.harnessCopied = existsSync(join(cwd, 'checks.sh'));
        try { state.oracleValueAtCheck = readFileSync(join(cwd, 'tests/oracle.test.ts'), 'utf-8'); } catch { /* 케이스에서 사용하지 않음 */ }
      }
      return state.verifyOutcomes.shift() ?? ({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        durationMs: 5,
        outputTail: 'checks passed',
      });
    });
    state.getRunsByWorkflowId.mockReset().mockReturnValue([
      { tokens_in: 12, tokens_out: 34 },
    ]);
    state.insertRun.mockReset();
    state.updateRun.mockReset();
    state.loadModelsFromCli.mockReset();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('copies a fixture, labels runs as eval, records token usage, and compares with the prior baseline', async () => {
    const caseDir = addCase('small-ts', { autoMergeCategory: 'docs' });
    const first = await runEval({ casesDir, dataDir, tempRoot });

    expect(first.artifact.summary).toMatchObject({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(first.artifact.results[0]).toMatchObject({
      caseId: 'small-ts',
      autoMergeCategory: 'docs',
      model: 'configured',
      tokensIn: 12,
      tokensOut: 34,
      routeCount: 1,
    });
    expect(first.artifact.results[0].policyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.artifact.schemaVersion).toBe(3);
    expect(state.insertRun).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'eval',
      triggerSource: 'eval',
      status: 'RUNNING',
    }));
    expect(state.runSpec).toHaveBeenCalledWith('Implement small-ts.', expect.objectContaining({
      cwd: expect.any(String),
      triggerSource: 'eval',
      agentModels: expect.objectContaining({ scaffold: 'anthropic:configured' }),
    }));
    expect(state.fixtureValue).toBe('small-ts');
    expect(state.fixtureHead).toMatch(/^[a-f0-9]{40}$/);
    expect(existsSync(join(caseDir, 'fixture', 'fixture.txt'))).toBe(true);
    expect(state.updateRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'DONE' }));

    state.runSpec.mockImplementationOnce(async (_spec: string, opts: { workflowRunId: string }) => ({
      workflowRunId: opts.workflowRunId,
      steps: {},
      totalDurationMs: 30,
      verdict: 'NEEDS-WORK',
      routeCount: 2,
    }));
    const second = await runEval({ casesDir, dataDir, tempRoot });
    expect(second.artifact.baselineFile).toBe(first.file);
    expect(second.artifact.summary.regressions).toEqual([
      `${first.artifact.results[0].caseId} [${first.artifact.results[0].model}]`,
    ]);
  });

  it('runs an initial bug reproduction check and assigns each requested model to all workflow roles', async () => {
    addCase('bug-case', { reproCommand: 'npm test' });
    state.verifyOutcomes = [
      { exitCode: 1, timedOut: false, cancelled: false, durationMs: 4, outputTail: 'reproduced' },
      { exitCode: 0, timedOut: false, cancelled: false, durationMs: 6, outputTail: 'checks passed' },
    ];

    const result = await runEval({ casesDir, dataDir, tempRoot, models: ['anthropic:sonnet'] });

    expect(state.loadModelsFromCli).toHaveBeenCalledOnce();
    expect(result.artifact.results[0]).toMatchObject({ pass: true, reproBaseline: { exitCode: 1 } });
    expect(state.runSpec).toHaveBeenCalledWith('Implement bug-case.', expect.objectContaining({
      reproCommand: 'npm test',
      agentModels: expect.objectContaining({
        planner: 'anthropic:sonnet',
        scaffold: 'anthropic:sonnet',
        test: 'anthropic:sonnet',
        review: 'anthropic:sonnet',
      }),
      signal: expect.any(AbortSignal),
    }));
    const reproTimeoutMs = state.runSpec.mock.calls[0][1].reproTimeoutMs as number;
    expect(reproTimeoutMs).toBeGreaterThan(0);
    expect(reproTimeoutMs).toBeLessThanOrEqual(1000);
  });

  it('marks work skipped when the daily run limit is exhausted', async () => {
    addCase('small-ts');
    state.allow = false;

    const result = await runEval({ casesDir, dataDir, tempRoot });

    expect(result.artifact.summary).toMatchObject({ total: 1, passed: 0, failed: 0, skipped: 1 });
    expect(state.runSpec).not.toHaveBeenCalled();
    expect(state.insertRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'BLOCKED', triggerSource: 'eval' }));
  });

  it('accepts clarification cases only when the workflow stops for clarification', async () => {
    addCase('clarify', { expectedResult: 'CLARIFICATION' });
    state.runSpec.mockImplementation(async (_spec: string, opts: { workflowRunId: string }) => ({
      workflowRunId: opts.workflowRunId,
      steps: {},
      totalDurationMs: 10,
      verdict: 'NEEDS-CLARIFICATION',
      routeCount: 0,
    }));

    const result = await runEval({ casesDir, dataDir, tempRoot });

    expect(result.artifact.results[0].pass).toBe(true);
    expect(state.runVerify).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ command: `bash '${join(casesDir, 'clarify', 'checks.sh')}'` }), expect.objectContaining({
      env: expect.objectContaining({ AUTO_DEV_EVAL_VERDICT: 'NEEDS-CLARIFICATION', AUTO_DEV_EVAL_ROUTE_COUNT: '0', AUTO_DEV_EVAL_INTEGRITY_VIOLATIONS: '0' }),
    }));
  });

  it('keeps checks.sh outside the project and overlays oracle files after the workflow', async () => {
    const caseDir = addCase('isolated-checks', { oracleFiles: { 'tests/oracle.test.ts': 'trusted oracle\n' } });
    state.runSpec.mockImplementationOnce(async (_spec: string, opts: { workflowRunId: string; cwd: string }) => {
      writeFileSync(join(opts.cwd, 'tests/oracle.test.ts'), 'agent changed this\n');
      return { workflowRunId: opts.workflowRunId, steps: {}, totalDurationMs: 10, verdict: 'SHIP', integrityViolations: 0 };
    });

    const result = await runEval({ casesDir, dataDir, tempRoot });

    expect(result.artifact.results[0]).toMatchObject({ pass: true, oracleApplied: true, integrityViolations: 0 });
    expect(state.harnessCopied).toBe(false);
    expect(state.oracleValueAtCheck).toBe('trusted oracle\n');
    expect(state.verifyCalls.at(-1)?.command).toBe(`bash '${join(caseDir, 'checks.sh')}'`);
  });

  it('accepts REJECT only for a non-SHIP verdict with zero integrity violations', async () => {
    addCase('integrity-reject', { expectedResult: 'REJECT' });
    state.runSpec.mockImplementationOnce(async (_spec: string, opts: { workflowRunId: string }) => ({
      workflowRunId: opts.workflowRunId, steps: {}, totalDurationMs: 10, verdict: 'FAILED', integrityViolations: 0,
    }));

    const result = await runEval({ casesDir, dataDir, tempRoot });

    expect(result.artifact.results[0]).toMatchObject({ pass: true, expectedResult: 'REJECT', integrityViolations: 0 });
    expect(state.verifyCalls.at(-1)?.env).toMatchObject({ AUTO_DEV_EVAL_EXPECTED: 'REJECT', AUTO_DEV_EVAL_INTEGRITY_VIOLATIONS: '0' });
  });

  it('fails eval even when checks pass if the workflow recorded integrity violations', async () => {
    addCase('integrity-violation', { expectedResult: 'REJECT' });
    state.runSpec.mockImplementationOnce(async (_spec: string, opts: { workflowRunId: string }) => ({
      workflowRunId: opts.workflowRunId, steps: {}, totalDurationMs: 10, verdict: 'FAILED', integrityViolations: 1,
    }));

    const result = await runEval({ casesDir, dataDir, tempRoot });

    expect(result.artifact.results[0]).toMatchObject({ pass: false, integrityViolations: 1 });
    expect(result.artifact.results[0].failure).toContain('integrity violation');
  });

  it('fails the case when its deterministic checks exit nonzero', async () => {
    addCase('check-fails');
    state.runVerify.mockResolvedValueOnce({
      exitCode: 2,
      timedOut: false,
      cancelled: false,
      durationMs: 7,
      outputTail: 'assertion failed',
    });

    const result = await runEval({ casesDir, dataDir, tempRoot });

    expect(result.artifact.summary).toMatchObject({ passed: 0, failed: 1 });
    expect(result.artifact.results[0]).toMatchObject({
      pass: false,
      checks: { exitCode: 2, outputTail: 'assertion failed' },
    });
    expect(state.updateRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: 'FAILED',
      errorType: 'eval_failed',
    }));
  });

  it('blocks a bug case when its initial reproduction command already passes', async () => {
    addCase('already-fixed', { reproCommand: 'npm test' });
    state.runVerify.mockResolvedValueOnce({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      durationMs: 3,
      outputTail: 'no bug reproduced',
    });

    const result = await runEval({ casesDir, dataDir, tempRoot });

    expect(result.artifact.results[0]).toMatchObject({ pass: false, verdict: 'BLOCKED' });
    expect(result.artifact.results[0].failure).toContain('not reproduced');
    expect(state.runSpec).not.toHaveBeenCalled();
    expect(state.updateRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: 'BLOCKED',
      errorType: 'not_reproduced',
    }));
  });
});
