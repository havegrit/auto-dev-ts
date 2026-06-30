import { randomUUID } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { runSpec, type SpecResult } from './spec.js';
import { composeClarifierInput, renderPlanDoc, planSlug, type ClarificationRound } from './clarification.js';
import { insertRun, updateRun } from '../store/runs.js';
import { saveClarificationState, getClarificationState, type ClarificationState } from '../store/clarification.js';

export interface SpecSessionOptions {
  project?: string;
  cwd: string;
  steps?: Set<string>;
  iterations?: number;
  triggerSource?: string;
}

export interface SpecSessionHandle {
  runId: string;
  /** 백그라운드 실행이 끝나면 resolve. HTTP 핸들러는 무시해도 되고, 테스트는 await. */
  done: Promise<void>;
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
    rounds: [],
  };
  return launch(state, opts);
}

/**
 * 멈춰 있던 세션을 사용자 답변으로 재개한다. 원본 스펙을 다시 입력할 필요 없이,
 * 마지막(미답변) 라운드에 답을 채워 "스펙 + 누적 Q&A" 로 새 워크플로우를 시작한다.
 */
export function resumeSpecSession(parentRunId: string, answers: Record<string, string>): SpecSessionHandle {
  const prev = getClarificationState(parentRunId);
  if (!prev) throw new Error(`No clarification state for run: ${parentRunId}`);

  const rounds = prev.rounds.map((r) => ({ ...r }));
  const last = rounds[rounds.length - 1];
  if (last && !roundIsAnswered(last)) {
    last.answers = { ...(last.answers ?? {}), ...answers };
  }

  const state: ClarificationState = { ...prev, rounds };
  return launch(state, {
    project: prev.project,
    cwd: prev.cwd,
    triggerSource: 'dashboard',
  });
}

/** 멈춘 run 의 아직 답하지 않은 마지막 라운드(=대시보드에 띄울 질문)를 반환한다. */
export function pendingClarification(runId: string): ClarificationRound | undefined {
  const state = getClarificationState(runId);
  const last = state?.rounds[state.rounds.length - 1];
  if (!last || roundIsAnswered(last)) return undefined;
  return last;
}

function roundIsAnswered(round: ClarificationRound): boolean {
  const answers = round.answers ?? {};
  return Object.values(answers).some((a) => a != null && String(a).trim());
}

function launch(state: ClarificationState, opts: SpecSessionOptions): SpecSessionHandle {
  const runId = randomUUID();
  const input = composeClarifierInput(state.spec, state.rounds);
  insertRun({
    id: runId,
    agentName: 'spec',
    input: input.slice(0, 4000),
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    triggerSource: opts.triggerSource ?? 'dashboard',
  });

  const done = finalize(runId, state, opts, input);
  return { runId, done };
}

async function finalize(runId: string, state: ClarificationState, opts: SpecSessionOptions, input: string): Promise<void> {
  const wallStart = Date.now();
  try {
    const result = await runSpec(input, {
      workflowRunId: runId,
      steps: opts.steps,
      iterations: opts.iterations,
      triggerSource: opts.triggerSource ?? 'dashboard',
      cwd: state.cwd,
    });

    writePlanDoc(state, result);

    if (result.verdict === 'NEEDS-CLARIFICATION' && result.clarification) {
      const rounds: ClarificationRound[] = [...state.rounds, { questions: result.clarification.questions }];
      saveClarificationState(runId, { ...state, rounds });
      updateRun(runId, {
        output: `${stepSummary(result)}\n\n${JSON.stringify(result.clarification, null, 2)}`,
        status: 'DONE',
        durationMs: result.totalDurationMs,
      });
      return;
    }

    updateRun(runId, {
      output: stepSummary(result),
      status: result.verdict === 'BLOCKED' || result.verdict === 'FAILED' ? 'FAILED' : 'DONE',
      durationMs: result.totalDurationMs,
    });
  } catch (err) {
    updateRun(runId, {
      output: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      status: 'FAILED',
      durationMs: Date.now() - wallStart,
    });
  }
}

function stepSummary(result: SpecResult): string {
  return Object.entries(result.steps)
    .map(([k, v]) => `${k}: ${v.status}`)
    .join(', ');
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
