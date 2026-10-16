import { randomUUID } from 'node:crypto';
import { insertRun, updateRun } from '../store/runs.js';
import { emitRunEvent } from '../lib/run-events.js';
import { registerRunCancellation } from '../lib/run-cancellation.js';
import { runVerify, verifyPassed, verifyFailureReason, type VerifyOutcome } from '../lib/verify.js';
import type { VerifyConfig } from '../lib/project-config.js';
import { log } from '../lib/logger.js';

/** verify 는 planner 가 배정하지 않는 내부 단계다. AGENT_ORDER 에는 들어가지 않는다. */
export const VERIFY_AGENT_NAME = 'verify';

export interface VerifyStepResult {
  runId: string;
  passed: boolean;
  outcome: VerifyOutcome;
}

export interface VerifyStepOptions {
  projectDir: string;
  verify: VerifyConfig;
  workflowRunId: string;
  specSessionId?: string;
  triggerSource?: string;
  triggerDetail?: string;
  /** `fail`이면 비영 종료 코드를 재현 성공으로 기록한다. */
  expectedOutcome?: 'pass' | 'fail';
  signal?: AbortSignal;
}

/** 라우팅 피드백에 실을 본문. 에이전트가 고칠 수 있도록 명령과 출력 꼬리를 그대로 준다. */
export function verifyFeedbackBody(config: VerifyConfig, outcome: VerifyOutcome): string {
  return [
    `검증 명령이 실패했다. 테스트 단계의 PASS 보고와 무관하게, 이 명령의 종료 코드가 최종 판정이다.`,
    '',
    `- command: \`${config.command}\``,
    `- result: ${verifyFailureReason(outcome)} (${outcome.durationMs}ms)`,
    '',
    '```',
    outcome.outputTail || '(no output)',
    '```',
  ].join('\n');
}

function verifyRunOutput(config: VerifyConfig, outcome: VerifyOutcome, expectedOutcome: 'pass' | 'fail'): string {
  const expectedFailureObserved = expectedOutcome === 'fail' && outcome.exitCode !== null &&
    outcome.exitCode !== 0 && outcome.exitCode !== 126 && outcome.exitCode !== 127 && !outcome.timedOut && !outcome.cancelled;
  const notReproduced = expectedOutcome === 'fail' && verifyPassed(outcome);
  const verdict = expectedFailureObserved
    ? `EXPECTED FAILURE OBSERVED (exit code ${outcome.exitCode})`
    : notReproduced
      ? 'NOT REPRODUCED (exit code 0)'
      : verifyPassed(outcome) ? 'PASS' : `FAIL (${verifyFailureReason(outcome)})`;
  return `$ ${config.command}\n→ ${verdict} in ${outcome.durationMs}ms\n\n${outcome.outputTail || '(no output)'}`;
}

/**
 * 검증 명령을 실행하고 결과를 `agent_run` 에 기록한다.
 *
 * `agent_name='verify'` 행으로 남기므로 대시보드의 워크플로 상세 화면이 기존
 * 자식 단계 렌더링 그대로 verify 결과(종료 코드 요약, 소요 시간, 출력 꼬리)를 보여준다.
 * 스키마 변경은 필요하지 않다.
 */
export async function runVerifyStep(opts: VerifyStepOptions): Promise<VerifyStepResult> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  insertRun({
    id: runId,
    agentName: VERIFY_AGENT_NAME,
    input: opts.verify.command,
    status: 'RUNNING',
    startedAt,
    triggerSource: opts.triggerSource ?? 'cli',
    triggerDetail: opts.triggerDetail ?? 'verification-gate',
    workflowRunId: opts.workflowRunId,
    specSessionId: opts.specSessionId,
  });

  // 대시보드의 run 취소와 부모 workflow 취소 양쪽에서 프로세스 그룹을 내릴 수 있게 한다.
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(opts.signal?.reason);
  if (opts.signal?.aborted) abortFromParent();
  else opts.signal?.addEventListener('abort', abortFromParent, { once: true });
  const unregister = registerRunCancellation(runId, controller);

  try {
    const outcome = await runVerify(opts.projectDir, opts.verify, { signal: controller.signal });
    const expectedOutcome = opts.expectedOutcome ?? 'pass';
    const expectedFailureObserved = expectedOutcome === 'fail' && outcome.exitCode !== null &&
      outcome.exitCode !== 0 && outcome.exitCode !== 126 && outcome.exitCode !== 127 && !outcome.timedOut && !outcome.cancelled;
    const notReproduced = expectedOutcome === 'fail' && verifyPassed(outcome);
    const passed = expectedOutcome === 'fail' ? expectedFailureObserved : verifyPassed(outcome);
    const status = passed ? 'DONE' : notReproduced || (expectedOutcome === 'fail' && (outcome.timedOut || outcome.cancelled)) ? 'BLOCKED' : 'FAILED';
    const errorType = outcome.cancelled
      ? 'user_cancelled'
      : outcome.timedOut ? 'verify_timeout' : notReproduced ? 'not_reproduced' : passed ? undefined : 'verify_failed';
    updateRun(runId, {
      output: verifyRunOutput(opts.verify, outcome, expectedOutcome),
      status,
      durationMs: outcome.durationMs,
      ...(errorType ? { errorType, stopReason: errorType } : {}),
    });
    emitRunEvent(runId, {
      type: 'status',
      ts: new Date().toISOString(),
      data: passed ? 'DONE' : `${status}:${errorType}`,
    });
    log[passed ? 'info' : 'warn'](
      { runId, command: opts.verify.command, exitCode: outcome.exitCode, timedOut: outcome.timedOut, durationMs: outcome.durationMs },
      expectedOutcome === 'fail'
        ? passed ? 'Bug reproduction observed' : 'Bug reproduction check did not match expectation'
        : passed ? 'Verification command passed' : 'Verification command failed',
    );
    return { runId, passed, outcome };
  } finally {
    opts.signal?.removeEventListener('abort', abortFromParent);
    unregister();
  }
}
