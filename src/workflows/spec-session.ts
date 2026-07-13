import { randomUUID } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { runSpec, workflowOutput, workflowRunStatus, STEP_ORDER, type SpecResult, type Step } from './spec.js';
import { composeClarifierInput, renderPlanDoc, planSlug, type ClarificationRound } from './clarification.js';
import { getRunsByWorkflowId, insertRun, updateRun } from '../store/runs.js';
import { saveClarificationState, getClarificationState, type ClarificationState } from '../store/clarification.js';
import { closeEmitter, emitRunEvent } from '../lib/run-events.js';
import { registerRunCancellation } from '../lib/run-cancellation.js';

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
  const state: ClarificationState = { ...prev, rounds, autoClarify, maxClarifyRounds };
  saveClarificationState(parentRunId, state);
  return launch(state, {
    project: prev.project,
    cwd: prev.cwd,
    steps: restoreSteps(prev.steps),
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
  const state: ClarificationState = { ...prev, rounds };
  return launch(state, {
    project: prev.project,
    cwd: prev.cwd,
    steps: restoreSteps(prev.steps),
    autoClarify: prev.autoClarify,
    maxClarifyRounds: prev.maxClarifyRounds,
    triggerSource: 'dashboard',
    triggerDetail: `continue:${parentRunId.slice(0, 8)}`,
  });
}

/**
 * 실패했거나 다시 시도하고 싶은 spec run 을 마지막으로 실행된 단계부터 재개한다.
 * 이전 planner 산출물을 상태에서 복원해 scaffold/test/review/cicd 입력으로 그대로 사용한다.
 */
export function resumeLastSpecStep(parentRunId: string, instruction?: string): SpecSessionHandle {
  const prev = getClarificationState(parentRunId);
  if (!prev) throw new Error(`No clarification state for run: ${parentRunId}`);

  const lastStep = lastExecutedWorkflowStep(parentRunId);
  if (!lastStep) throw new Error(`No workflow steps found for run: ${parentRunId}`);

  const extra = (instruction ?? '').trim();
  const state: ClarificationState = { ...prev, rounds: prev.rounds.map((r) => ({ ...r })) };

  return launch(state, {
    project: prev.project,
    cwd: prev.cwd,
    steps: restoreSteps(prev.steps),
    autoClarify: prev.autoClarify,
    maxClarifyRounds: prev.maxClarifyRounds,
    triggerSource: 'dashboard',
    triggerDetail: `resume:${parentRunId.slice(0, 8)}:${lastStep}`,
    resumeInstruction: extra || undefined,
  }, {
    startStep: lastStep,
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

function lastExecutedWorkflowStep(parentRunId: string): Step | undefined {
  const children = getRunsByWorkflowId(parentRunId).filter((r) => isWorkflowStep(r.agent_name));
  return children.at(-1)?.agent_name as Step | undefined;
}

function serializeSteps(steps: Set<string> | undefined): string[] | undefined {
  return steps ? [...steps] : undefined;
}

function restoreSteps(steps: string[] | undefined): Set<string> | undefined {
  return steps ? new Set(steps) : undefined;
}

function launch(state: ClarificationState, opts: SpecSessionOptions, resume?: { startStep: Step }): SpecSessionHandle {
  const runId = randomUUID();
  const input = composeClarifierInput(state.spec, state.rounds);
  mkdirSync(state.cwd, { recursive: true });
  insertRun({
    id: runId,
    agentName: 'spec',
    input: input.slice(0, 4000),
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    triggerSource: opts.triggerSource ?? 'dashboard',
    triggerDetail: opts.triggerDetail,
  });
  // 모든 spec run 의 상태를 영속화해 나중에 후속 수정 지시로 이어갈 수 있게 한다.
  // (게이트에서 멈추면 finalize 가 질문 라운드를 더해 다시 저장한다.)
  saveClarificationState(runId, state);

  const abortController = new AbortController();
  const unregisterCancellation = registerRunCancellation(runId, abortController);
  const done = finalize(runId, state, opts, input, resume, abortController.signal)
    .finally(unregisterCancellation);
  return { runId, done };
}

async function finalize(runId: string, state: ClarificationState, opts: SpecSessionOptions, input: string, resume: { startStep: Step } | undefined, signal: AbortSignal): Promise<void> {
  const wallStart = Date.now();
  try {
    const result = await runSpec(input, {
      workflowRunId: runId,
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
      return;
    }

    saveClarificationState(runId, { ...merged, planOutput });
    const status = workflowRunStatus(result);
    updateRun(runId, {
      output: workflowOutput(result),
      status,
      durationMs: result.totalDurationMs,
      ...(result.verdict === 'CANCELLED' ? { errorType: 'user_cancelled', stopReason: 'user_cancelled' } : {}),
    });
    finishRunEvents(runId, result.verdict === 'CANCELLED' ? 'CANCELLED' : status);
  } catch (err) {
    updateRun(runId, {
      output: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      status: 'FAILED',
      durationMs: Date.now() - wallStart,
    });
    finishRunEvents(runId, 'FAILED');
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
