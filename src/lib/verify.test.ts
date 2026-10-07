import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerify, verifyPassed, VERIFY_TAIL_MAX_LINES } from './verify.js';

let dir: string;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autodev-verify-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runVerify', () => {
  it('passes on exit code 0', async () => {
    const outcome = await runVerify(dir, { command: 'echo done', timeoutMs: 5000 });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.outputTail).toBe('done');
    expect(verifyPassed(outcome)).toBe(true);
  });

  it('fails on a non-zero exit code and keeps the output tail', async () => {
    const outcome = await runVerify(dir, { command: 'echo boom >&2; exit 1', timeoutMs: 5000 });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.outputTail).toBe('boom');
    expect(verifyPassed(outcome)).toBe(false);
  });

  it('runs the command inside the project directory', async () => {
    const outcome = await runVerify(dir, { command: 'pwd', timeoutMs: 5000 });

    expect(outcome.outputTail).toContain(dir.split('/').pop()!);
  });

  it('keeps only the last lines of a long output', async () => {
    const outcome = await runVerify(dir, { command: 'seq 1 1000', timeoutMs: 10000 });

    const lines = outcome.outputTail.split('\n');
    expect(lines.length).toBeLessThanOrEqual(VERIFY_TAIL_MAX_LINES);
    expect(lines[lines.length - 1]).toBe('1000');
    expect(outcome.outputTail).not.toContain('\n1\n');
  });

  it('marks a timeout instead of waiting forever', async () => {
    const outcome = await runVerify(dir, { command: 'sleep 30', timeoutMs: 100 });

    expect(outcome.timedOut).toBe(true);
    expect(verifyPassed(outcome)).toBe(false);
    expect(outcome.durationMs).toBeLessThan(5000);
  });

  it('kills the whole process group on abort so grandchildren cannot outlive the run', async () => {
    const marker = join(dir, 'marker');
    const controller = new AbortController();
    // 손자 프로세스가 같은 프로세스 그룹에 남는다. 부모 bash 만 죽이면 marker 가 생긴다.
    const promise = runVerify(
      dir,
      { command: `bash -c 'sleep 0.5; touch ${marker}' & wait`, timeoutMs: 10000 },
      { signal: controller.signal },
    );

    await wait(60);
    controller.abort();
    const outcome = await promise;

    expect(outcome.cancelled).toBe(true);
    expect(verifyPassed(outcome)).toBe(false);
    await wait(800);
    expect(existsSync(marker)).toBe(false);
  });

  it('reports failure instead of throwing when the command cannot start', async () => {
    const outcome = await runVerify(join(dir, 'does-not-exist'), { command: 'echo hi', timeoutMs: 5000 });

    expect(verifyPassed(outcome)).toBe(false);
  });
});
