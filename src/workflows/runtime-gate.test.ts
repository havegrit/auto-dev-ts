import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { insertRun, updateRun, emitRunEvent } = vi.hoisted(() => ({
  insertRun: vi.fn(),
  updateRun: vi.fn(),
  emitRunEvent: vi.fn(),
}));

vi.mock('../store/runs.js', () => ({ insertRun, updateRun }));
vi.mock('../lib/run-events.js', () => ({ emitRunEvent, closeEmitter: vi.fn(), getOrCreateEmitter: vi.fn() }));

import { readWorkflowEvidence } from '../lib/evidence.js';
import { runRuntimeVerification, type RuntimeGateDeps } from './runtime-gate.js';
import type { VerifyConfig } from '../lib/project-config.js';

let dir: string;
let evidenceRoot: string;

const runtime = {
  up: 'docker compose up -d --wait',
  down: 'docker compose down -v',
  healthcheck: { url: 'http://localhost:8080/health', timeoutMs: 25 },
  checks: ['.auto-dev/checks/smoke.sh'],
};

function commandResult(exitCode = 0, outputTail = '') {
  return { exitCode, timedOut: false, cancelled: false, durationMs: 3, outputTail };
}

function verifierResult(output = 'GET /widgets → 200\n[VERIFY: PASS]') {
  return { runId: 'verifier-run', output, tokensIn: 1, tokensOut: 1, durationMs: 5, status: 'DONE' as const };
}

function deps(overrides: Partial<RuntimeGateDeps> = {}): RuntimeGateDeps {
  return {
    runCommand: vi.fn<RuntimeGateDeps['runCommand']>(async () => commandResult()),
    fetch: vi.fn(async () => new Response('ready', { status: 200 })),
    sleep: vi.fn(async () => {}),
    runVerifier: vi.fn(async () => verifierResult()),
    snapshot: vi.fn(async () => new Map()),
    writeEvidence: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autodev-runtime-'));
  evidenceRoot = mkdtempSync(join(tmpdir(), 'autodev-evidence-'));
  insertRun.mockClear();
  updateRun.mockClear();
  emitRunEvent.mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(evidenceRoot, { recursive: true, force: true });
});

const options = () => ({
  projectDir: dir,
  runtime,
  workflowRunId: 'workflow-12345678',
  specContent: '위젯 생성 API 구현',
  evidenceRoot,
});

describe('runRuntimeVerification', () => {
  it('fails after runtime up failure and still runs down', async () => {
    const runCommand = vi.fn<RuntimeGateDeps['runCommand']>()
      .mockResolvedValueOnce(commandResult(2, 'compose failed'))
      .mockResolvedValueOnce(commandResult());
    const testDeps = deps({ runCommand });

    const result = await runRuntimeVerification(options(), testDeps);

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('compose failed');
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand.mock.calls[1][1].command).toBe(runtime.down);
    expect(testDeps.fetch).not.toHaveBeenCalled();
  });

  it('records a healthcheck timeout and runs cleanup', async () => {
    const runCommand = vi.fn<RuntimeGateDeps['runCommand']>(async () => commandResult());
    const testDeps = deps({
      runCommand,
      fetch: vi.fn(async () => new Response('starting', { status: 503 })),
      sleep: vi.fn(async (ms: number) => { await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)); }),
    });

    const result = await runRuntimeVerification(options(), testDeps);

    expect(result.passed).toBe(false);
    expect(result.records.find((entry) => entry.stage === 'healthcheck')).toMatchObject({
      status: 'FAIL',
      request: { method: 'GET', url: runtime.healthcheck.url },
      response: { status: 503, bodyTail: 'starting' },
    });
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand.mock.calls[1][1].command).toBe(runtime.down);
  });

  it('fails a deterministic check without invoking the verifier', async () => {
    const runCommand = vi.fn<RuntimeGateDeps['runCommand']>()
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult(1, 'smoke assertion failed'))
      .mockResolvedValueOnce(commandResult());
    const testDeps = deps({ runCommand });

    const result = await runRuntimeVerification(options(), testDeps);

    expect(result.passed).toBe(false);
    expect(result.records.find((entry) => entry.stage.startsWith('check:'))?.outputTail).toBe('smoke assertion failed');
    expect(testDeps.runVerifier).not.toHaveBeenCalled();
    expect(runCommand.mock.calls.at(-1)?.[1].command).toBe(runtime.down);
  });

  it('fails when the verifier reports mismatched runtime behavior', async () => {
    const runCommand = vi.fn<RuntimeGateDeps['runCommand']>(async () => commandResult());
    const testDeps = deps({
      runCommand,
      runVerifier: vi.fn(async () => verifierResult('POST /widgets → 500\n[VERIFY: FAIL]')),
    });

    const result = await runRuntimeVerification(options(), testDeps);

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('POST /widgets → 500');
    expect(result.records.find((entry) => entry.stage === 'verifier')?.status).toBe('FAIL');
    expect(runCommand.mock.calls.at(-1)?.[1].command).toBe(runtime.down);
  });

  it('runs the verifier in a fresh run with feature-map context and captures evidence', async () => {
    const testDeps = deps();

    const result = await runRuntimeVerification(options(), testDeps);

    expect(result.passed).toBe(true);
    expect(testDeps.runVerifier).toHaveBeenCalledWith('verifier', expect.stringContaining('## 요청 스펙'), expect.objectContaining({
      workflowRunId: 'workflow-12345678',
      env: { COMPOSE_PROJECT_NAME: 'autodev-workflow' },
    }));
    expect(testDeps.fetch).toHaveBeenCalledWith(runtime.healthcheck.url, expect.objectContaining({ method: 'GET' }));
    expect((testDeps.runCommand as any).mock.calls[0][2].env).toEqual({ COMPOSE_PROJECT_NAME: 'autodev-workflow' });
    expect(testDeps.writeEvidence).toHaveBeenCalledWith('workflow-12345678', expect.arrayContaining([
      expect.objectContaining({ stage: 'healthcheck', status: 'PASS', response: expect.objectContaining({ bodyTail: 'ready' }) }),
      expect.objectContaining({ stage: 'verifier', status: 'PASS', report: expect.stringContaining('[VERIFY: PASS]') }),
    ]), evidenceRoot);
  });

  it('marks a verifier workspace edit as a role-boundary failure', async () => {
    const testDeps = deps({
      snapshot: vi.fn()
        .mockResolvedValueOnce(new Map())
        .mockResolvedValueOnce(new Map([['src/main.ts', 'changed-hash']])),
    });

    const result = await runRuntimeVerification(options(), testDeps);

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('src/main.ts');
    expect(result.records.find((entry) => entry.stage === 'verifier')).toMatchObject({
      status: 'FAIL',
      changedFiles: ['src/main.ts'],
    });
  });

  it('checks workspace changes even when the verifier runner throws', async () => {
    const testDeps = deps({
      runVerifier: vi.fn(async () => { throw new Error('provider stopped'); }),
      snapshot: vi.fn()
        .mockResolvedValueOnce(new Map())
        .mockResolvedValueOnce(new Map([['src/main.ts', 'changed-hash']])),
    });

    const result = await runRuntimeVerification(options(), testDeps);

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('src/main.ts');
    expect(result.records.find((entry) => entry.stage === 'verifier')).toMatchObject({
      status: 'FAIL',
      changedFiles: ['src/main.ts'],
      report: 'verifier error: provider stopped',
    });
  });

  it('runs down after cancellation and stores request and response evidence', async () => {
    const controller = new AbortController();
    const commands: string[] = [];
    const runCommand = vi.fn<RuntimeGateDeps['runCommand']>(async (_projectDir: string, config: VerifyConfig) => {
      commands.push(config.command);
      if (config.command === runtime.up) {
        controller.abort();
        return { ...commandResult(130), cancelled: true };
      }
      return commandResult();
    });
    const testDeps = deps({ runCommand });

    const result = await runRuntimeVerification({ ...options(), signal: controller.signal }, testDeps);

    expect(result.cancelled).toBe(true);
    expect(commands).toEqual([runtime.up, runtime.down]);
    expect(testDeps.runVerifier).not.toHaveBeenCalled();
  });

  it('writes evidence as a dashboard-readable workflow file', async () => {
    const testDeps = deps();
    const result = await runRuntimeVerification(options(), {
      ...testDeps,
      writeEvidence: async (workflowRunId, records, root) => {
        const { writeWorkflowEvidence } = await import('../lib/evidence.js');
        await writeWorkflowEvidence(workflowRunId, records, root);
      },
    });

    const stored = await readWorkflowEvidence('workflow-12345678', evidenceRoot);
    expect(stored?.records).toHaveLength(result.records.length);
    expect(readFileSync(join(evidenceRoot, 'workflow-12345678', 'evidence.json'), 'utf-8')).toContain('runtime-down');
  });
});
