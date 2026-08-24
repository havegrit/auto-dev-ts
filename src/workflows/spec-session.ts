import { randomUUID } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { runSpec, workflowOutput, workflowRunStatus, STEP_ORDER, type SpecResult, type Step } from './spec.js';
import { composeClarifierInput, renderPlanDoc, planSlug, type ClarificationRound } from './clarification.js';
import { getRunsByWorkflowId, insertRun, updateRun } from '../store/runs.js';
import { saveClarificationState, getClarificationState, type ClarificationState } from '../store/clarification.js';
import { closeEmitter, emitRunEvent } from '../lib/run-events.js';
import { registerRunCancellation } from '../lib/run-cancellation.js';
import { notifyOpenClawSpec } from '../integrations/openclaw/notify.js';

export interface SpecSessionOptions {
  project?: string;
  cwd: string;
  steps?: Set<string>;
  iterations?: number;
  triggerSource?: string;
  triggerDetail?: string;
  /** skip 모드: clarifier 질문을 AI 추천 답안으로 자동 답변해 멈추지 않고 진행한다. */
  autoClarify?: boolean;
  /** 자동 답변 최대 라운드. 0이면 무제한. */
  maxClarifyRounds?: number;
  /** resume-last 로 재시작할 때 첫 실행 입력에 한 번만 붙일 후속 지시. */
  resumeInstruction?: string;
  /** cicd 단계의 의도. 기본은 CI만, CD는 명시적으로 요청된 경우에만. */
  deliveryIntent?: 'ci' | 'cd';
}

export interface SpecSessionHandle {
  runId: string;
  /** 백그라운드 실행이 끝나면 resolve. HTTP 핸들러는 무시해도 되고, 테스트는 await. */
  done: Promise<void>;
}

export interface ResumeSpecSessionOptions {
  autoClarify?: boolean;
  maxClarifyRounds?: number;
}

/** 새 spec 워크플로우 세션을 시작한다 (clarifier 라운드 0). */
export function startSpecSession(spec: string, opts: SpecSessionOptions): SpecSessionHandle {
  const slug = planSlug(opts.project, spec);
  const state: ClarificationState = {
    spec,
    project: opts.project,
    slug,
    planFile: join('docs', 'plan', `${slug}.md`),
    cwd: opts.cwd,
    steps: serializeSteps(opts.steps),
    iterations: opts.iterations,
    autoClarify: opts.autoClarify,
    maxClarifyRounds: opts.maxClarifyRounds,
    rounds: [],
  };
  return launch(state, opts);
}

/**
 * 멈춰 있던 세션을 사용자 답변으로 재개한다. 원본 스펙을 다시 입력할 필요 없이,
 * 마지막(미답변) 라운드에 답을 채워 "스펙 + 누적 Q&A" 로 새 워크플로우를 시작한다.
 */
export function resumeSpecSession(parentRunId: string, answers: Record<string, string>, followup?: string, fallbackQuestions?: ClarificationRound['questions'], resumeOpts: ResumeSpecSessionOptions = {}): SpecSessionHandle {
  const prev = getClarificationState(parentRunId);
  if (!prev) throw new Error(`No clarification state for run: ${parentRunId}`);

  const rounds = prev.rounds.map((r) => ({ ...r }));
  const last = rounds[rounds.length - 1];
  const extra = (followup ?? '').trim();
  if (last && !roundIsAnswered(last)) {
    last.answers = { ...(last.answers ?? {}), ...answers };
  } else if (fallbackQuestions?.length) {
    rounds.push({ questions: fallbackQuestions, answers });
  }
  // 질문 답변 외에 사용자가 덧붙인 추가 요청을 같은 라운드에 실어 보낸다.
  const current = rounds[rounds.length - 1];
  if (current && extra) current.followup = extra;
  else if (extra) rounds.push({ questions: [], followup: extra });

  const autoClarify = resumeOpts.autoClarify ?? prev.autoClarify ?? false;
  const maxClarifyRounds = resumeOpts.maxClarifyRounds ?? prev.maxClarifyRounds ?? 0;
  const state: ClarificationState = { ...prev, sessionId: prev.sessionId ?? parentRunId, rounds, autoClarify, maxClarifyRounds };
  saveClarificationState(parentRunId, state);
  return launch(state, {
    project: prev.project,
    cwd: prev.cwd,
    steps: restoreSteps(prev.steps),
    iterations: prev.iterations,
    autoClarify,
    maxClarifyRounds,
    triggerSource: 'dashboard',
    triggerDetail: `answers:${parentRunId.slice(0, 8)}`,
  });
}

/**
 * 완료된(또는 실패한) spec run 을 사용자 후속 수정 지시로 이어간다.
 * 원본 스펙을 다시 입력할 필요 없이, 누적 히스토리 뒤에 새 지시를 한 라운드로 더해
 * "스펙 + 누적 Q&A + 누적 후속지시" 로 파이프라인을 처음부터 다시 실행한다.
 */
export function continueSpecSession(parentRunId: string, instruction: string): SpecSessionHandle {
  const prev = getClarificationState(parentRunId);
  if (!prev) throw new Error(`No clarification state for run: ${parentRunId}`);

  const text = instruction.trim();
  const rounds: ClarificationRound[] = text
    ? [...prev.rounds.map((r) => ({ ...r })), { questions: [], followup: text }]
    : [...prev.rounds.map((r) => ({ ...r }))];
  const state: ClarificationState = { ...prev, sessionId: prev.sessionId ?? parentRunId, rounds };
  return launch(state, {
    project: prev.project,
    cwd: prev.cwd,
    steps: restoreSteps(prev.steps),
    iterations: prev.iterations,
    autoClarify: prev.autoClarify,
    maxClarifyRounds: prev.maxClarifyRounds,
    triggerSource: 'dashboard',
    triggerDetail: `continue:${parentRunId.slice(0, 8)}`,
  });
}

/**
 * 실패했거나 다시 시도하고 싶은 spec run 을 마지막으로 실행된 단계부터 재개한다.
 * 이전 planner 산출물을 상태에서 복원해 scaffold/test/review/cicd 입력으로 그대로 사용한다.
 * startStepOverride 를 주면 자동 판단(resumeTarget) 대신 그 단계부터 강제로 재개한다 —
 * 예: clarifier 가 유효하지 않은 응답으로 막혔을 때 사용자가 clarifier/planner를 건너뛰고
 * scaffold 부터 바로 실행하고 싶은 경우.
 */
export function resumeLastSpecStep(parentRunId: string, instruction?: string, startStepOverride?: Step): SpecSessionHandle {
  const prev = getClarificationState(parentRunId);
  if (!prev) throw new Error(`No clarification state for run: ${parentRunId}`);

  const lastRun = lastExecutedWorkflowRun(parentRunId);
  if (!lastRun) throw new Error(`No workflow steps found for run: ${parentRunId}`);

  const resume = startStepOverride
    ? { startStep: startStepOverride, useFeedback: false }
    : resumeTarget(lastRun, prev.steps);
  if (!resume) throw new Error('No remaining workflow steps to resume');

  const extra = (instruction ?? '').trim();
  const state: ClarificationState = { ...prev, sessionId: prev.sessionId ?? parentRunId, rounds: prev.rounds.map((r) => ({ ...r })) };
  const feedback = resume.useFeedback && lastRun.output?.trim()
    ? [lastRun.output.trim(), extra].filter(Boolean).join('\n\n')
    : extra || undefined;

  return launch(state, {
    project: prev.project,
    cwd: prev.cwd,
    steps: restoreSteps(prev.steps),
    iterations: prev.iterations,
    autoClarify: prev.autoClarify,
    maxClarifyRounds: prev.maxClarifyRounds,
    triggerSource: 'dashboard',
    triggerDetail: `resume:${parentRunId.slice(0, 8)}:${resume.startStep}`,
    resumeInstruction: feedback,
  }, {
    startStep: resume.startStep,
  });
}

/** 멈춘 run 의 아직 답하지 않은 마지막 라운드(=대시보드에 띄울 질문)를 반환한다. */
export function pendingClarification(runId: string): ClarificationRound | undefined {
  const state = getClarificationState(runId);
  const last = state?.rounds[state.rounds.length - 1];
  if (!last || roundIsAnswered(last)) return undefined;
  return last;
}

/**
 * run 에 저장된 상태로부터 plan 문서(원본 스펙 + 의사결정 히스토리 + 플랜)를 재생성한다.
 * 대시보드에서 이어가기 전에 이전 플랜을 보여주는 데 쓴다. 상태가 없으면 undefined.
 */
export function specRunPlan(runId: string): string | undefined {
  const state = getClarificationState(runId);
  if (!state) return undefined;
  return renderPlanDoc({
    project: state.project,
    spec: state.spec,
    rounds: state.rounds,
    planOutput: state.planOutput,
  });
}

function roundIsAnswered(round: ClarificationRound): boolean {
  const answers = round.answers ?? {};
  return Object.values(answers).some((a) => a != null && String(a).trim());
}

function isWorkflowStep(value: string): value is Step {
  return (STEP_ORDER as readonly string[]).includes(value);
}

function lastExecutedWorkflowRun(parentRunId: string) {
  const children = getRunsByWorkflowId(parentRunId).filter((r) => isWorkflowStep(r.agent_name));
  return children.at(-1);
}

function markerValue(output: string | undefined, name: string): string | undefined {
  const matches = [...String(output ?? '').matchAll(new RegExp(`\\[${name}:\\s*([^\\]]+)\\]`, 'gi'))];
  return matches.at(-1)?.[1]?.trim().toLowerCase();
}

function routedStep(output: string | undefined): Step | undefined {
  const route = markerValue(output, 'ROUTE');
  return route && isWorkflowStep(route) ? route : undefined;
}

function resumeTarget(lastRun: ReturnType<typeof lastExecutedWorkflowRun>, configuredSteps?: string[]): { startStep: Step; useFeedback: boolean } | undefined {
  if (!lastRun) return undefined;
  const enabled = configuredSteps ? new Set(configuredSteps) : new Set<string>(STEP_ORDER);
  const lastStep = lastRun.agent_name as Step;
  const verdict = markerValue(lastRun.output, 'VERDICT');
  const tests = markerValue(lastRun.output, 'TESTS');
  // runSpec은 review verdict가 누락되면 안전하게 NEEDS-WORK로 해석한다.
  // 과거 실행 resume도 같은 규칙을 써야 marker가 모두 빠진 최신 실패를 복구할 수 있다.
  const needsRework = verdict === 'needs-work' || tests === 'fail' || (lastStep === 'review' && !verdict);
  // 과거/비준수 에이전트 출력에 ROUTE가 없으면 구현 수정의 기본 소유자인 planner로 복구한다.
  const route = routedStep(lastRun.output) ?? (needsRework ? 'planner' : undefined);

  // The agent completed but requested rework. Resume at the routed owner and
  // carry the original review/test output into that agent instead of rerunning
  // the reviewer/tester and spending tokens on the same work.
  if (lastRun.status === 'DONE' && route && needsRework) {
    return enabled.has(route) ? { startStep: route, useFeedback: true } : undefined;
  }

  // A completed step should not be repeated. Continue with the next enabled
  // workflow step; genuinely failed/cancelled agent runs are retried in place.
  if (lastRun.status !== 'DONE') return { startStep: lastStep, useFeedback: false };
  const index = STEP_ORDER.indexOf(lastStep);
  const next = STEP_ORDER.slice(index + 1).find(step => enabled.has(step));
  return next ? { startStep: next, useFeedback: false } : undefined;
}

function serializeSteps(steps: Set<string> | undefined): string[] | undefined {
  return steps ? [...steps] : undefined;
}

function restoreSteps(steps: string[] | undefined): Set<string> | undefined {
  return steps ? new Set(steps) : undefined;
}

function launch(state: ClarificationState, opts: SpecSessionOptions, resume?: { startStep: Step }): SpecSessionHandle {
  const runId = randomUUID();
  const sessionState: ClarificationState = { ...state, sessionId: state.sessionId ?? runId };
  const input = composeClarifierInput(sessionState.spec, sessionState.rounds);
  mkdirSync(sessionState.cwd, { recursive: true });
  insertRun({
    id: runId,
    agentName: 'spec',
    input: input.slice(0, 4000),
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    triggerSource: opts.triggerSource ?? 'dashboard',
    triggerDetail: opts.triggerDetail,
    specSessionId: sessionState.sessionId,
  });
  // 모든 spec run 의 상태를 영속화해 나중에 후속 수정 지시로 이어갈 수 있게 한다.
  // (게이트에서 멈추면 finalize 가 질문 라운드를 더해 다시 저장한다.)
  saveClarificationState(runId, sessionState);

  const abortController = new AbortController();
  const unregisterCancellation = registerRunCancellation(runId, abortController);
  const done = finalize(runId, sessionState, opts, input, resume, abortController.signal)
    .finally(unregisterCancellation);
  return { runId, done };
}

async function finalize(runId: string, state: ClarificationState, opts: SpecSessionOptions, input: string, resume: { startStep: Step } | undefined, signal: AbortSignal): Promise<void> {
  const wallStart = Date.now();
  try {
    const result = await runSpec(input, {
      workflowRunId: runId,
      specSessionId: state.sessionId,
      steps: opts.steps,
      iterations: opts.iterations,
      autoClarify: opts.autoClarify,
      maxClarifyRounds: opts.maxClarifyRounds,
      initialFeedback: opts.resumeInstruction,
      deliveryIntent: opts.deliveryIntent ?? 'ci',
      triggerSource: opts.triggerSource ?? 'dashboard',
      cwd: state.cwd,
      startStep: resume?.startStep,
      initialPlanOutput: state.planOutput,
      signal,
    });

    // skip 모드가 추천 답안으로 자동 답변한 라운드를 히스토리에 편입해
    // plan 문서와 저장 상태(이후 이어가기)에 그 결정들이 남게 한다.
    const autoRounds: ClarificationRound[] = (result.autoClarifyRounds ?? []).map((r) => ({
      questions: r.questions,
      answers: r.answers,
    }));
    const merged: ClarificationState = autoRounds.length
      ? { ...state, rounds: [...state.rounds, ...autoRounds] }
      : state;

    writePlanDoc(merged, result);

    // 이 run 의 플랜을 상태에 남겨 나중에 이어갈 때 대시보드에서 볼 수 있게 한다.
    // 이번 run 이 플랜을 산출하지 못했으면(게이트에서 멈춤) 직전 플랜을 유지한다.
    const planOutput = result.planOutput ?? merged.planOutput;

    if (result.verdict === 'NEEDS-CLARIFICATION' && result.clarification) {
      const rounds: ClarificationRound[] = [...merged.rounds, { questions: result.clarification.questions }];
      saveClarificationState(runId, { ...merged, rounds, planOutput });
      updateRun(runId, {
        output: `${workflowOutput(result)}\n\n${JSON.stringify(result.clarification, null, 2)}`,
        status: 'DONE',
        durationMs: result.totalDurationMs,
      });
      finishRunEvents(runId, 'DONE');
      await notifyOpenClawSpec({
        runId,
        project: opts.project,
        verdict: result.verdict,
        durationMs: result.totalDurationMs,
        clarificationCount: result.clarification.questions.length,
      });
      return;
    }

    saveClarificationState(runId, { ...merged, planOutput });
    const status = workflowRunStatus(result);
    updateRun(runId, {
      output: workflowOutput(result),
      status,
      durationMs: result.totalDurationMs,
      ...(result.verdict === 'CANCELLED'
        ? { errorType: 'user_cancelled', stopReason: 'user_cancelled' }
        : result.failure
          ? { errorType: 'workflow_failure', stopReason: result.failure.step }
          : {}),
    });
    finishRunEvents(runId, result.verdict === 'CANCELLED' ? 'CANCELLED' : status);
    await notifyOpenClawSpec({
      runId,
      project: opts.project,
      verdict: result.verdict ?? status,
      durationMs: result.totalDurationMs,
      reason: result.failure?.reason,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateRun(runId, {
      output: `ERROR: ${message}`,
      status: 'FAILED',
      durationMs: Date.now() - wallStart,
    });
    finishRunEvents(runId, 'FAILED');
    await notifyOpenClawSpec({
      runId,
      project: opts.project,
      verdict: 'FAILED',
      durationMs: Date.now() - wallStart,
      reason: message,
    });
  }
}

function finishRunEvents(runId: string, status: 'DONE' | 'FAILED' | 'CANCELLED'): void {
  emitRunEvent(runId, { type: 'status', ts: new Date().toISOString(), data: status });
  closeEmitter(runId);
}

/** plan 파일을 cwd/docs/plan/<slug>.md 에 항상 최신 전체 스냅샷으로 기록한다. */
function writePlanDoc(state: ClarificationState, result: SpecResult): void {
  const doc = renderPlanDoc({
    project: state.project,
    spec: state.spec,
    rounds: state.rounds,
    planOutput: result.planOutput,
  });
  const abs = join(state.cwd, state.planFile);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, doc);
}
