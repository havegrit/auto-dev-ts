import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { AGENT_ORDER } from '../agents/specs.js';
import { costGuard } from '../lib/cost-guard.js';
import { loadModelsFromCli, modelConfig } from '../lib/model-config.js';
import { runVerify, verifyPassed, type VerifyOutcome } from '../lib/verify.js';
import { getRunsByWorkflowId, insertRun, updateRun } from '../store/runs.js';
import { runSpec, type SpecResult } from './spec.js';

export type EvalExpectedResult = 'SHIP' | 'CLARIFICATION';

export interface EvalCaseMeta {
  tags?: string[];
  expectedResult: EvalExpectedResult | 'NEEDS-CLARIFICATION';
  timeoutMs?: number;
  /** 버그 fixture의 수정 전 재현 명령. 0이 아닌 종료 코드를 기대한다. */
  reproCommand?: string;
}

export interface EvalCheckResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

export interface EvalCaseResult {
  caseId: string;
  tags: string[];
  model: string;
  agentModels?: Record<string, string>;
  pass: boolean;
  expectedResult: EvalExpectedResult;
  verdict?: string;
  routeCount: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  checks?: EvalCheckResult;
  reproBaseline?: EvalCheckResult;
  failure?: string;
  skipped?: boolean;
}

export interface EvalArtifact {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  baselineFile?: string;
  results: EvalCaseResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    regressions: string[];
    improvements: string[];
  };
}

export interface RunEvalOptions {
  caseId?: string;
  models?: string[];
  casesDir?: string;
  dataDir?: string;
  tempRoot?: string;
}

interface LoadedEvalCase {
  id: string;
  spec: string;
  meta: EvalCaseMeta;
  fixtureDir: string;
  checksPath: string;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MODEL_ROLES = [...new Set([...AGENT_ORDER, 'verifier'])];

function normalizeExpectedResult(value: EvalCaseMeta['expectedResult']): EvalExpectedResult {
  if (value === 'SHIP') return 'SHIP';
  if (value === 'CLARIFICATION' || value === 'NEEDS-CLARIFICATION') return 'CLARIFICATION';
  throw new Error(`Invalid expectedResult: ${String(value)} (expected SHIP or CLARIFICATION)`);
}

function validateCaseId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`Invalid eval case id "${id}"; use lowercase letters, numbers, and hyphens`);
  }
}

async function loadEvalCase(casesDir: string, id: string): Promise<LoadedEvalCase> {
  validateCaseId(id);
  const dir = resolve(casesDir, id);
  if (basename(dir) !== id || resolve(dir, '..') !== resolve(casesDir)) {
    throw new Error(`Eval case path escapes cases directory: ${id}`);
  }
  const spec = await readFile(join(dir, 'spec.md'), 'utf-8').catch((err: unknown) => {
    throw new Error(`Eval case ${id} is missing spec.md: ${errorMessage(err)}`);
  });
  let meta: EvalCaseMeta;
  try {
    meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf-8')) as EvalCaseMeta;
  } catch (err) {
    throw new Error(`Eval case ${id} has invalid meta.json: ${errorMessage(err)}`);
  }
  meta.expectedResult = normalizeExpectedResult(meta.expectedResult);
  if (meta.timeoutMs !== undefined && (!Number.isFinite(meta.timeoutMs) || meta.timeoutMs <= 0)) {
    throw new Error(`Eval case ${id} timeoutMs must be a positive number`);
  }
  if (meta.reproCommand !== undefined && !meta.reproCommand.trim()) {
    throw new Error(`Eval case ${id} reproCommand must not be empty`);
  }
  if (meta.tags !== undefined && (!Array.isArray(meta.tags) || meta.tags.some((tag) => typeof tag !== 'string'))) {
    throw new Error(`Eval case ${id} tags must be an array of strings`);
  }
  const fixtureDir = join(dir, 'fixture');
  const checksPath = join(dir, 'checks.sh');
  const checksStat = await stat(checksPath).catch(() => undefined);
  if (!checksStat?.isFile()) throw new Error(`Eval case ${id} is missing checks.sh`);
  const fixtureStat = await stat(fixtureDir).catch(() => undefined);
  return { id, spec, meta, fixtureDir: fixtureStat?.isDirectory() ? fixtureDir : '', checksPath };
}

function asCheckResult(outcome: VerifyOutcome): EvalCheckResult {
  return {
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
    outputTail: outcome.outputTail,
  };
}

function expectedVerdictMatches(expected: EvalExpectedResult, verdict: string | undefined): boolean {
  if (expected === 'SHIP') return verdict === 'SHIP';
  return verdict === 'NEEDS-CLARIFICATION' || verdict === 'CLARIFICATION';
}

function modelOverrides(model: string | undefined): Record<string, string> | undefined {
  return model ? Object.fromEntries(MODEL_ROLES.map((role) => [role, model])) : undefined;
}

function sumUsage(workflowRunId: string): { tokensIn: number; tokensOut: number } {
  return getRunsByWorkflowId(workflowRunId).reduce((sum, run) => ({
    tokensIn: sum.tokensIn + (run.tokens_in ?? 0),
    tokensOut: sum.tokensOut + (run.tokens_out ?? 0),
  }), { tokensIn: 0, tokensOut: 0 });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function listCaseIds(casesDir: string): Promise<string[]> {
  const entries = await readdir(casesDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function latestBaseline(dataDir: string): Promise<{ file: string; artifact: EvalArtifact } | undefined> {
  const entries = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
  const file = entries
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}T.*\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  if (!file) return undefined;
  try {
    return { file, artifact: JSON.parse(await readFile(join(dataDir, file), 'utf-8')) as EvalArtifact };
  } catch (err) {
    throw new Error(`Could not read previous eval baseline ${file}: ${errorMessage(err)}`);
  }
}

async function runCase(
  testCase: LoadedEvalCase,
  model: string,
  overrides: Record<string, string> | undefined,
  tempRoot: string,
): Promise<EvalCaseResult> {
  const started = Date.now();
  const caseTimeoutMs = testCase.meta.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const remainingMs = () => Math.max(0, caseTimeoutMs - (Date.now() - started));
  const base: EvalCaseResult = {
    caseId: testCase.id,
    tags: testCase.meta.tags ?? [],
    model,
    agentModels: overrides,
    pass: false,
    expectedResult: normalizeExpectedResult(testCase.meta.expectedResult),
    routeCount: 0,
    tokensIn: 0,
    tokensOut: 0,
    durationMs: 0,
  };

  const workflowRunId = randomUUID();
  const runStartedAt = new Date().toISOString();
  const allowed = costGuard.allow();
  insertRun({
    id: workflowRunId,
    agentName: 'eval',
    input: testCase.spec.slice(0, 4000),
    status: allowed ? 'RUNNING' : 'BLOCKED',
    startedAt: runStartedAt,
    triggerSource: 'eval',
    triggerDetail: `eval:${testCase.id}:${model}`,
  });
  if (!allowed) {
    updateRun(workflowRunId, { output: 'Daily run limit exceeded.', status: 'BLOCKED', durationMs: 0 });
    return { ...base, skipped: true, verdict: 'BLOCKED', failure: 'Daily run limit exceeded.' };
  }

  const projectDir = await mkdtemp(join(tempRoot, `auto-dev-eval-${testCase.id}-`));
  try {
    if (testCase.fixtureDir) await cp(testCase.fixtureDir, projectDir, { recursive: true, force: true });
    await cp(testCase.checksPath, join(projectDir, 'checks.sh'));
    if (testCase.meta.reproCommand) {
      const repro = await runVerify(projectDir, {
        command: testCase.meta.reproCommand,
        timeoutMs: Math.max(1, remainingMs()),
      });
      base.reproBaseline = asCheckResult(repro);
      const failureObserved = repro.exitCode !== null && repro.exitCode !== 0 &&
        repro.exitCode !== 126 && repro.exitCode !== 127 && !repro.timedOut && !repro.cancelled;
      if (!failureObserved) {
        const failure = `Bug was not reproduced before the workflow (${repro.timedOut ? 'timed out' : `exit code ${repro.exitCode ?? 'signal'}`}).`;
        updateRun(workflowRunId, { output: failure, status: 'BLOCKED', durationMs: Date.now() - started, errorType: 'not_reproduced' });
        return {
          ...base,
          verdict: 'BLOCKED',
          failure,
          durationMs: Date.now() - started,
        };
      }
    }

    const workflowSignal = AbortSignal.timeout(Math.max(1, remainingMs()));
    const specResult: SpecResult = await runSpec(testCase.spec, {
      cwd: projectDir,
      workflowRunId,
      triggerSource: 'eval',
      triggerDetail: `eval:${testCase.id}:${model}`,
      reproCommand: testCase.meta.reproCommand,
      reproTimeoutMs: remainingMs(),
      agentModels: overrides,
      signal: workflowSignal,
    });
    const usage = sumUsage(workflowRunId);
    base.verdict = specResult.verdict;
    base.routeCount = specResult.routeCount ?? 0;
    base.tokensIn = usage.tokensIn;
    base.tokensOut = usage.tokensOut;
    base.durationMs = specResult.totalDurationMs;

    if (workflowSignal.aborted) {
      base.verdict = 'CANCELLED';
      base.failure = `Eval case timed out after ${caseTimeoutMs}ms during the spec workflow.`;
      base.durationMs = Date.now() - started;
      updateRun(workflowRunId, {
        output: base.failure,
        status: 'FAILED',
        durationMs: base.durationMs,
        errorType: 'eval_timeout',
      });
      return base;
    }

    const check = remainingMs() > 0
      ? await runVerify(projectDir, {
        command: 'bash checks.sh',
        timeoutMs: Math.max(1, remainingMs()),
      }, {
        env: {
          AUTO_DEV_EVAL_CASE_ID: testCase.id,
          AUTO_DEV_EVAL_MODEL: model,
          AUTO_DEV_EVAL_EXPECTED: base.expectedResult,
          AUTO_DEV_EVAL_VERDICT: specResult.verdict ?? '',
          AUTO_DEV_EVAL_ROUTE_COUNT: String(base.routeCount),
        },
      })
      : {
        exitCode: null,
        timedOut: true,
        cancelled: false,
        durationMs: 0,
        outputTail: 'Eval case timed out before checks.sh could run.',
      };
    base.checks = asCheckResult(check);
    base.durationMs = Date.now() - started;
    base.pass = expectedVerdictMatches(base.expectedResult, specResult.verdict) && verifyPassed(check);
    if (!base.pass) {
      base.failure = !expectedVerdictMatches(base.expectedResult, specResult.verdict)
        ? `Expected ${base.expectedResult}, got ${specResult.verdict ?? 'no verdict'}.`
        : `checks.sh ${check.timedOut ? 'timed out' : `exited ${check.exitCode ?? 'with a signal'}`}.`;
    }
    updateRun(workflowRunId, {
      output: `verdict=${base.verdict ?? 'none'} expected=${base.expectedResult} checks=${check.exitCode ?? 'signal'} pass=${base.pass}`,
      status: base.pass ? 'DONE' : 'FAILED',
      durationMs: Date.now() - started,
      ...(!base.pass ? { errorType: 'eval_failed', stopReason: base.failure } : {}),
    });
    return base;
  } catch (err) {
    const failure = errorMessage(err);
    updateRun(workflowRunId, {
      output: failure,
      status: 'FAILED',
      durationMs: Date.now() - started,
      errorType: 'eval_failed',
      stopReason: failure,
    });
    return { ...base, failure, durationMs: Date.now() - started };
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

function compareWithBaseline(results: EvalCaseResult[], baseline: EvalArtifact | undefined): {
  regressions: string[];
  improvements: string[];
} {
  const key = (result: EvalCaseResult) =>
    `${result.caseId}\0${result.model}\0${JSON.stringify(result.agentModels ?? {})}`;
  const oldResults = new Map((baseline?.results ?? []).map((result) => [key(result), result]));
  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const result of results) {
    const old = oldResults.get(key(result));
    if (!old || old.skipped || result.skipped) continue;
    const label = `${result.caseId} [${result.model}]`;
    if (old.pass && !result.pass) regressions.push(label);
    if (!old.pass && result.pass) improvements.push(label);
  }
  return { regressions, improvements };
}

export async function runEval(opts: RunEvalOptions = {}): Promise<{ file: string; artifact: EvalArtifact }> {
  const startedAt = new Date().toISOString();
  const casesDir = resolve(opts.casesDir ?? join(process.cwd(), 'evals', 'cases'));
  const dataDir = resolve(opts.dataDir ?? join(process.cwd(), 'data', 'evals'));
  const tempRoot = resolve(opts.tempRoot ?? tmpdir());
  await mkdir(tempRoot, { recursive: true });
  const ids = opts.caseId ? [opts.caseId] : await listCaseIds(casesDir);
  if (ids.length === 0) throw new Error(`No eval cases found in ${casesDir}`);
  const cases = await Promise.all(ids.map((id) => loadEvalCase(casesDir, id)));
  const requestedModels = opts.models?.map((model) => model.trim()).filter(Boolean);
  if (requestedModels && requestedModels.length === 0) throw new Error('--models requires at least one model ID');
  if (requestedModels) {
    await loadModelsFromCli();
    const unknown = [...new Set(requestedModels)].filter((model) => !modelConfig.hasRunnableModel(model));
    if (unknown.length > 0) throw new Error(`Unknown or unsupported eval model(s): ${unknown.join(', ')}`);
  }
  const modelMatrix = requestedModels ? [...new Set(requestedModels)] : [undefined];
  const previous = await latestBaseline(dataDir);
  const results: EvalCaseResult[] = [];
  for (const testCase of cases) {
    for (const model of modelMatrix) {
      const configuredModels = model ? undefined : modelConfig.getAgentModels();
      const label = model ?? 'configured';
      results.push(await runCase(testCase, label, modelOverrides(model) ?? configuredModels, tempRoot));
    }
  }

  const comparison = compareWithBaseline(results, previous?.artifact);
  const finishedAt = new Date().toISOString();
  const artifact: EvalArtifact = {
    schemaVersion: 1,
    startedAt,
    finishedAt,
    baselineFile: previous?.file,
    results,
    summary: {
      total: results.length,
      passed: results.filter((result) => result.pass).length,
      failed: results.filter((result) => !result.pass && !result.skipped).length,
      skipped: results.filter((result) => result.skipped).length,
      ...comparison,
    },
  };
  await mkdir(dataDir, { recursive: true });
  const timestamp = finishedAt.replace(/[:.]/g, '-');
  const file = `${timestamp}-${randomUUID().slice(0, 8)}.json`;
  const outputPath = join(dataDir, file);
  const tempPath = `${outputPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
  await rename(tempPath, outputPath);
  return { file, artifact };
}

export function formatEvalSummary(artifact: EvalArtifact, file: string): string {
  const lines = [`eval: ${artifact.summary.passed}/${artifact.summary.total} passed; saved data/evals/${file}`];
  for (const result of artifact.results) {
    const status = result.skipped ? 'SKIPPED' : result.pass ? 'PASS' : 'FAIL';
    const stats = `verdict=${result.verdict ?? 'none'} routes=${result.routeCount} tokens=${result.tokensIn + result.tokensOut} duration=${result.durationMs}ms`;
    lines.push(`${status} ${result.caseId} [${result.model}] ${stats}${result.failure ? ` — ${result.failure}` : ''}`);
  }
  if (artifact.baselineFile) lines.push(`baseline: data/evals/${artifact.baselineFile}`);
  if (artifact.summary.regressions.length) lines.push(`regressions: ${artifact.summary.regressions.join(', ')}`);
  if (artifact.summary.improvements.length) lines.push(`improvements: ${artifact.summary.improvements.join(', ')}`);
  return lines.join('\n');
}
