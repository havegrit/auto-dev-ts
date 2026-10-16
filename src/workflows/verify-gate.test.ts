import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { insertRun, updateRun, emitRunEvent } = vi.hoisted(() => ({
  insertRun: vi.fn(),
  updateRun: vi.fn(),
  emitRunEvent: vi.fn(),
}));

vi.mock('../store/runs.js', () => ({ insertRun, updateRun }));
vi.mock('../lib/run-events.js', () => ({ emitRunEvent, closeEmitter: vi.fn(), getOrCreateEmitter: vi.fn() }));

import { runVerifyStep, verifyFeedbackBody } from './verify-gate.js';
import { cancelActiveRun } from '../lib/run-cancellation.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autodev-gate-'));
  insertRun.mockClear();
  updateRun.mockClear();
  emitRunEvent.mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runVerifyStep', () => {
  it('records a passing verify run on the workflow', async () => {
    const result = await runVerifyStep({
      projectDir: dir,
      verify: { command: 'echo ok', timeoutMs: 5000 },
      workflowRunId: 'wf-1',
      specSessionId: 'session-1',
    });

    expect(result.passed).toBe(true);
    expect(insertRun).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'verify',
      input: 'echo ok',
      status: 'RUNNING',
      workflowRunId: 'wf-1',
      specSessionId: 'session-1',
    }));
    expect(updateRun).toHaveBeenCalledWith(result.runId, expect.objectContaining({ status: 'DONE' }));
    expect(updateRun.mock.calls[0][1].output).toContain('echo ok');
  });

  it('records a failing verify run with the output tail and an error type', async () => {
    const result = await runVerifyStep({
      projectDir: dir,
      verify: { command: 'echo broken >&2; exit 3', timeoutMs: 5000 },
      workflowRunId: 'wf-2',
    });

    expect(result.passed).toBe(false);
    expect(result.outcome.exitCode).toBe(3);
    expect(updateRun).toHaveBeenCalledWith(result.runId, expect.objectContaining({
      status: 'FAILED',
      errorType: 'verify_failed',
    }));
    expect(updateRun.mock.calls[0][1].output).toContain('broken');
    expect(emitRunEvent).toHaveBeenCalledWith(result.runId, expect.objectContaining({ data: 'FAILED:verify_failed' }));
  });

  it('records a non-zero exit as an observed bug reproduction when failure is expected', async () => {
    const result = await runVerifyStep({
      projectDir: dir,
      verify: { command: 'echo reproduced >&2; exit 4', timeoutMs: 5000 },
      workflowRunId: 'wf-repro-observed',
      expectedOutcome: 'fail',
      triggerDetail: 'bug-reproduction-baseline',
    });

    expect(result.passed).toBe(true);
    expect(result.outcome.exitCode).toBe(4);
    expect(insertRun).toHaveBeenCalledWith(expect.objectContaining({ triggerDetail: 'bug-reproduction-baseline' }));
    expect(updateRun).toHaveBeenCalledWith(result.runId, expect.objectContaining({
      status: 'DONE',
      output: expect.stringContaining('EXPECTED FAILURE OBSERVED'),
    }));
  });

  it('blocks an expected failure check when the repro command passes', async () => {
    const result = await runVerifyStep({
      projectDir: dir,
      verify: { command: 'echo no-failure', timeoutMs: 5000 },
      workflowRunId: 'wf-repro-missing',
      expectedOutcome: 'fail',
    });

    expect(result.passed).toBe(false);
    expect(result.outcome.exitCode).toBe(0);
    expect(updateRun).toHaveBeenCalledWith(result.runId, expect.objectContaining({
      status: 'BLOCKED',
      errorType: 'not_reproduced',
      output: expect.stringContaining('NOT REPRODUCED'),
    }));
  });

  it('does not treat a missing command as an observed bug reproduction', async () => {
    const result = await runVerifyStep({
      projectDir: dir,
      verify: { command: '__autodev_missing_repro_command__', timeoutMs: 5000 },
      workflowRunId: 'wf-repro-command-missing',
      expectedOutcome: 'fail',
    });

    expect(result.passed).toBe(false);
    expect(result.outcome.exitCode).toBe(127);
    expect(updateRun).toHaveBeenCalledWith(result.runId, expect.objectContaining({ status: 'FAILED', errorType: 'verify_failed' }));
    expect(updateRun.mock.calls[0][1].output).not.toContain('EXPECTED FAILURE OBSERVED');
  });

  it('marks a timeout with its own error type', async () => {
    const result = await runVerifyStep({
      projectDir: dir,
      verify: { command: 'sleep 30', timeoutMs: 100 },
      workflowRunId: 'wf-3',
    });

    expect(result.outcome.timedOut).toBe(true);
    expect(updateRun).toHaveBeenCalledWith(result.runId, expect.objectContaining({ errorType: 'verify_timeout' }));
  });

  it('stops when the parent workflow is aborted', async () => {
    const controller = new AbortController();
    const promise = runVerifyStep({
      projectDir: dir,
      verify: { command: 'sleep 30', timeoutMs: 30000 },
      workflowRunId: 'wf-4',
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    const result = await promise;

    expect(result.outcome.cancelled).toBe(true);
    expect(result.passed).toBe(false);
    expect(updateRun).toHaveBeenCalledWith(result.runId, expect.objectContaining({ errorType: 'user_cancelled' }));
  });

  it('is cancellable by run id so the dashboard can stop it', async () => {
    let runId = '';
    insertRun.mockImplementationOnce((row: { id: string }) => { runId = row.id; });
    const promise = runVerifyStep({
      projectDir: dir,
      verify: { command: 'sleep 30', timeoutMs: 30000 },
      workflowRunId: 'wf-5',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(cancelActiveRun(runId)).toBe(true);
    const result = await promise;

    expect(result.outcome.cancelled).toBe(true);
  });
});

describe('verifyFeedbackBody', () => {
  it('carries the command and the output tail so the next step can act on it', () => {
    const body = verifyFeedbackBody(
      { command: './gradlew check', timeoutMs: 1000 },
      { exitCode: 1, timedOut: false, cancelled: false, durationMs: 42, outputTail: 'FooTest > bar FAILED' },
    );

    expect(body).toContain('./gradlew check');
    expect(body).toContain('exit code 1');
    expect(body).toContain('FooTest > bar FAILED');
  });
});
