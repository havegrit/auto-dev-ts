import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { insertRun, updateRun } from '../store/runs.js';
import { closeEmitter, emitRunEvent } from '../lib/run-events.js';
import { registerRunCancellation } from '../lib/run-cancellation.js';
import { DEFAULT_VERIFY_TIMEOUT_MS } from '../lib/project-config.js';
import type { RuntimeConfig } from '../lib/project-config.js';
import { findRoleBoundaryViolations, snapshotWorkspace } from '../lib/role-boundary.js';
import { runVerify, verifyPassed, verifyFailureReason, type VerifyOutcome } from '../lib/verify.js';
import { writeWorkflowEvidence, type EvidenceRecord } from '../lib/evidence.js';
import { runNamedAgent, type AgentRunOpts } from '../agents/dispatch.js';
import type { RunResult } from '../lib/runner.js';

export const RUNTIME_VERIFY_AGENT_NAME = 'verify';
const HEALTH_ATTEMPT_TIMEOUT_MS = 5_000;
const HEALTH_RETRY_INTERVAL_MS = 1_000;
const HEALTH_BODY_MAX_BYTES = 8 * 1024;

export interface RuntimeGateResult {
  runId: string;
  passed: boolean;
  cancelled: boolean;
  blocked: boolean;
  output: string;
  feedback: string;
  evidenceSummary: string;
  records: EvidenceRecord[];
}

export interface RuntimeGateOptions {
  projectDir: string;
  runtime: RuntimeConfig;
  workflowRunId: string;
  specContent: string;
  specSessionId?: string;
  triggerSource?: string;
  signal?: AbortSignal;
  runOpts?: AgentRunOpts;
  evidenceRoot?: string;
}

export interface RuntimeGateDeps {
  runCommand: typeof runVerify;
  fetch: typeof fetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  runVerifier: (name: string, input: string, opts: AgentRunOpts) => Promise<RunResult>;
  snapshot: typeof snapshotWorkspace;
  writeEvidence: typeof writeWorkflowEvidence;
}

const defaultDeps: RuntimeGateDeps = {
  runCommand: runVerify,
  fetch: globalThis.fetch,
  sleep: (ms, signal) => new Promise((resolveSleep) => {
    if (signal?.aborted) { resolveSleep(); return; }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolveSleep();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  }),
  runVerifier: runNamedAgent,
  snapshot: snapshotWorkspace,
  writeEvidence: writeWorkflowEvidence,
};

function tailText(text: string, maxBytes: number): string {
  let value = text;
  while (Buffer.byteLength(value, 'utf-8') > maxBytes) value = value.slice(Math.max(1, Math.floor(value.length / 8)));
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function composeProjectName(workflowRunId: string): string {
  const prefix = workflowRunId.slice(0, 8).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return `autodev-${prefix || randomUUID().slice(0, 8)}`;
}

function statusEvent(runId: string, data: string): void {
  emitRunEvent(runId, { type: 'tool_result', ts: new Date().toISOString(), data });
}

function commandRecord(stage: string, command: string, outcome: VerifyOutcome): EvidenceRecord {
  return {
    stage,
    status: verifyPassed(outcome) ? 'PASS' : outcome.cancelled ? 'BLOCKED' : 'FAIL',
    timestamp: new Date().toISOString(),
    durationMs: outcome.durationMs,
    command,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    cancelled: outcome.cancelled,
    outputTail: outcome.outputTail,
  };
}

function lastVerifyMarker(output: string): 'PASS' | 'FAIL' | 'BLOCKED' | undefined {
  const markers = [...output.matchAll(/\[VERIFY:\s*(PASS|FAIL|BLOCKED)\s*\]/gi)];
  const marker = markers.at(-1)?.[1]?.toUpperCase();
  return marker === 'PASS' || marker === 'FAIL' || marker === 'BLOCKED' ? marker : undefined;
}

function summarizeEvidence(records: EvidenceRecord[]): string {
  return records.map((record) => {
    const details = [
      record.command ? `command: ${record.command}` : undefined,
      record.request ? `request: ${record.request.method} ${record.request.url}` : undefined,
      record.response?.status !== undefined ? `HTTP ${record.response.status}` : undefined,
      record.exitCode !== undefined ? `exit: ${record.exitCode ?? 'signal'}` : undefined,
      record.durationMs !== undefined ? `${record.durationMs}ms` : undefined,
    ].filter(Boolean).join(', ');
    const tail = record.report ?? record.outputTail ?? record.response?.bodyTail ?? record.response?.error;
    return `- ${record.stage}: ${record.status}${details ? ` (${details})` : ''}${tail ? `\n  ${tailText(tail, 1200).replace(/\n/g, '\n  ')}` : ''}`;
  }).join('\n');
}

function outputFor(records: EvidenceRecord[], failure?: string): string {
  const summary = summarizeEvidence(records);
  return `런타임 검증 ${failure ? '실패' : '완료'}${failure ? `: ${failure}` : ''}\n\n${summary || '(증거 없음)'}`;
}

function failureFeedback(records: EvidenceRecord[], failure: string): string {
  return [
    '실행 중 런타임 검증이 실패했다. 아래 관찰 증거를 바탕으로 수정하고 다시 검증하라.',
    '',
    `실패 원인: ${failure}`,
    '',
    '## 검증 증거',
    summarizeEvidence(records) || '(증거 없음)',
  ].join('\n');
}

async function waitForHealth(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  deps: RuntimeGateDeps,
): Promise<{ passed: boolean; cancelled: boolean; durationMs: number; status?: number; bodyTail?: string; error?: string }> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastStatus: number | undefined;
  let lastBody = '';
  let lastError = '';

  while (Date.now() < deadline && !signal?.aborted) {
    const attemptMs = Math.max(1, Math.min(HEALTH_ATTEMPT_TIMEOUT_MS, deadline - Date.now()));
    const attemptTimeout = AbortSignal.timeout(attemptMs);
    const requestSignal = signal ? AbortSignal.any([signal, attemptTimeout]) : attemptTimeout;
    try {
      const response = await deps.fetch(url, { method: 'GET', signal: requestSignal });
      lastStatus = response.status;
      lastBody = tailText(await response.text(), HEALTH_BODY_MAX_BYTES);
      if (response.ok) {
        return { passed: true, cancelled: false, durationMs: Date.now() - startedAt, status: lastStatus, bodyTail: lastBody };
      }
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      if (signal?.aborted) return { passed: false, cancelled: true, durationMs: Date.now() - startedAt, status: lastStatus, bodyTail: lastBody, error: 'cancelled' };
      lastError = err instanceof Error ? err.message : String(err);
    }
    await deps.sleep(Math.min(HEALTH_RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now())), signal);
  }

  return {
    passed: false,
    cancelled: Boolean(signal?.aborted),
    durationMs: Date.now() - startedAt,
    status: lastStatus,
    bodyTail: lastBody,
    error: signal?.aborted ? 'cancelled' : lastError || 'healthcheck timed out',
  };
}

/** 런타임을 기동하고 실제 상태를 검증한다. down은 취소 중에도 finally에서 실행한다. */
export async function runRuntimeVerification(
  options: RuntimeGateOptions,
  overrides: Partial<RuntimeGateDeps> = {},
): Promise<RuntimeGateResult> {
  const deps = { ...defaultDeps, ...overrides };
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const env = { COMPOSE_PROJECT_NAME: composeProjectName(options.workflowRunId) };
  const records: EvidenceRecord[] = [];
  let failure: string | undefined;
  let cancelled = false;
  let blocked = false;

  insertRun({
    id: runId,
    agentName: RUNTIME_VERIFY_AGENT_NAME,
    input: `runtime up/checks/verifier/down for ${options.workflowRunId}`,
    status: 'RUNNING',
    startedAt,
    triggerSource: options.triggerSource ?? 'cli',
    triggerDetail: 'runtime-verification',
    workflowRunId: options.workflowRunId,
    specSessionId: options.specSessionId,
  });

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener('abort', abortFromParent, { once: true });
  const unregister = registerRunCancellation(runId, controller);
  const signal = controller.signal;

  const record = (entry: EvidenceRecord) => {
    records.push(entry);
    statusEvent(runId, `${entry.stage}: ${entry.status}`);
  };

  try {
    if (signal.aborted) {
      cancelled = true;
      failure = 'runtime verification cancelled before startup';
    } else {
      const up = await deps.runCommand(options.projectDir, {
        command: options.runtime.up,
        timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
      }, { signal, env });
      record(commandRecord('runtime-up', options.runtime.up, up));
      if (up.cancelled) cancelled = true;
      if (!verifyPassed(up)) failure = `runtime up ${verifyFailureReason(up)}`;
    }

    if (!failure && !signal.aborted) {
      const health = await waitForHealth(options.runtime.healthcheck.url, options.runtime.healthcheck.timeoutMs, signal, deps);
      record({
        stage: 'healthcheck',
        status: health.passed ? 'PASS' : health.cancelled ? 'BLOCKED' : 'FAIL',
        timestamp: new Date().toISOString(),
        durationMs: health.durationMs,
        request: { method: 'GET', url: options.runtime.healthcheck.url },
        response: { status: health.status, ok: health.passed, bodyTail: health.bodyTail, error: health.error },
        cancelled: health.cancelled,
      });
      if (health.cancelled) cancelled = true;
      if (!health.passed) failure = `healthcheck ${health.cancelled ? 'cancelled' : 'timed out or returned an error'}${health.status ? ` (HTTP ${health.status})` : ''}`;
    }

    if (!failure && !signal.aborted) {
      for (const script of options.runtime.checks) {
        const scriptPath = resolve(options.projectDir, script);
        const relative = scriptPath.slice(resolve(options.projectDir).length + 1);
        const command = `bash -- ${shellQuote(relative)}`;
        const outcome = await deps.runCommand(options.projectDir, {
          command,
          timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
        }, { signal, env });
        record(commandRecord(`check:${script}`, command, outcome));
        if (outcome.cancelled) cancelled = true;
        if (!verifyPassed(outcome)) {
          failure = `check ${script} ${verifyFailureReason(outcome)}`;
          break;
        }
      }
    }

    if (!failure && !signal.aborted) {
      const before = await deps.snapshot(options.projectDir);
      if (!before) {
        emitRunEvent(runId, {
          type: 'warn',
          ts: new Date().toISOString(),
          data: 'verifier_role_boundary_skipped: not a git repository',
        });
      }

      const verifierInput = [
        '## 요청 스펙',
        options.specContent,
        '',
        '서비스는 이미 기동되어 있다. feature-map과 실제 런타임을 이용해 핵심 동작을 요청·조회하고 관찰 증거를 보고하라.',
        '',
        '## 선행 런타임 증거',
        summarizeEvidence(records),
      ].join('\n');
      let verifier: RunResult | undefined;
      let changedFiles: string[] = [];
      try {
        verifier = await deps.runVerifier('verifier', verifierInput, {
          ...options.runOpts,
          cwd: options.projectDir,
          workflowRunId: options.workflowRunId,
          specSessionId: options.specSessionId,
          triggerSource: options.triggerSource ?? 'cli',
          signal,
          env,
        });
      } catch (err) {
        failure = `verifier error: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        if (before) {
          const after = await deps.snapshot(options.projectDir);
          changedFiles = after ? findRoleBoundaryViolations(before, after, { testGlobs: [], ignoreGlobs: [] }) : [];
        }
      }

      if (verifier && (signal.aborted || verifier.status === 'CANCELLED')) cancelled = true;
      const marker = verifier ? lastVerifyMarker(verifier.output) : undefined;
      record({
        stage: 'verifier',
        status: changedFiles.length ? 'FAIL' : marker === 'PASS' && verifier?.status === 'DONE' ? 'PASS' : marker === 'BLOCKED' || verifier?.status === 'BLOCKED' ? 'BLOCKED' : 'FAIL',
        timestamp: new Date().toISOString(),
        durationMs: verifier?.durationMs,
        report: verifier?.output ?? failure ?? 'Verifier did not return a result.',
        verifierRunId: verifier?.runId,
        changedFiles: changedFiles.length ? changedFiles : undefined,
      });
      if (changedFiles.length) {
        failure = `verifier modified workspace files: ${changedFiles.join(', ')}`;
      } else if (verifier && (marker === 'BLOCKED' || verifier.status === 'BLOCKED')) {
        blocked = true;
        failure = 'verifier was blocked before it could inspect the running service';
      } else if (!verifier || marker !== 'PASS' || verifier.status !== 'DONE') {
        failure ??= marker === 'FAIL' ? 'verifier observed behavior that does not match the spec' : 'verifier did not return [VERIFY: PASS]';
      }
    } else if (signal.aborted) {
      cancelled = true;
    }
  } catch (err) {
    failure ??= err instanceof Error ? err.message : String(err);
    if (signal.aborted) cancelled = true;
    record({
      stage: 'runtime-error',
      status: cancelled ? 'BLOCKED' : 'FAIL',
      timestamp: new Date().toISOString(),
      report: failure,
      cancelled,
    });
  } finally {
    // cleanup은 부모 취소 신호와 분리한다. up 중 취소되어도 down 명령을 실제 실행한다.
    try {
      const down = await deps.runCommand(options.projectDir, {
        command: options.runtime.down,
        timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
      }, { env });
      record(commandRecord('runtime-down', options.runtime.down, down));
      if (!verifyPassed(down)) failure ??= `runtime down ${verifyFailureReason(down)}`;
    } catch (err) {
      failure ??= `runtime down error: ${err instanceof Error ? err.message : String(err)}`;
      record({ stage: 'runtime-down', status: 'FAIL', timestamp: new Date().toISOString(), report: failure });
    }

    try {
      await deps.writeEvidence(options.workflowRunId, records, options.evidenceRoot);
    } catch (err) {
      failure ??= `evidence write error: ${err instanceof Error ? err.message : String(err)}`;
    }
    options.signal?.removeEventListener('abort', abortFromParent);
    unregister();
  }

  if (signal.aborted) cancelled = true;
  if (cancelled) failure ??= 'runtime verification cancelled';
  const passed = !failure && !cancelled && !blocked;
  const evidenceSummary = summarizeEvidence(records);
  const output = outputFor(records, failure);
  const feedback = failureFeedback(records, failure ?? 'runtime verification failed');
  const errorType = cancelled ? 'user_cancelled' : blocked ? 'verifier_blocked' : passed ? undefined : 'runtime_verify_failed';
  updateRun(runId, {
    output,
    status: passed ? 'DONE' : 'FAILED',
    durationMs: Date.now() - new Date(startedAt).getTime(),
    ...(errorType ? { errorType, stopReason: errorType } : {}),
  });
  emitRunEvent(runId, {
    type: 'status',
    ts: new Date().toISOString(),
    data: passed ? 'DONE' : `FAILED:${errorType}`,
  });
  closeEmitter(runId);
  return { runId, passed, cancelled, blocked, output, feedback, evidenceSummary, records };
}
