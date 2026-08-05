import { scaffold } from '../agents/scaffold.js';
import { review } from '../agents/review/index.js';
import { test } from '../agents/test.js';
import { cicd } from '../agents/cicd.js';
import { planner } from '../agents/planner.js';
import { clarifier } from '../agents/clarifier.js';
import { AGENT_ORDER } from '../agents/specs.js';
import { decorateCicdInput } from '../agents/dispatch.js';
import { randomUUID } from 'crypto';
import type { RunResult } from '../lib/runner.js';
import { insertRun, updateRun } from '../store/runs.js';

export interface SpecOptions {
  steps?: Set<string>;
  /** 피드백 재작업(라우팅) 허용 횟수. 미지정 시 iterations, 그것도 없으면 DEFAULT_MAX_ROUTES. */
  iterations?: number;
  maxRoutes?: number;
  triggerSource?: string;
  triggerDetail?: string;
  workflowRunId?: string;
  cwd?: string;
  /** skip 모드: clarifier 질문을 AI 추천 답안으로 자동 답변해 멈추지 않고 진행한다. */
  autoClarify?: boolean;
  /** autoClarify 자동 답변 최대 라운드. 0 또는 미지정이면 무제한. */
  maxClarifyRounds?: number;
  /** 이전 실행을 이어갈 때 시작할 단계. 지정 단계 이전은 건너뛴다. */
  startStep?: Step;
  /** 이전 실행에서 이미 산출한 planner 결과. startStep 이 scaffold 이후일 때 입력으로 쓴다. */
  initialPlanOutput?: string;
  /** resume-last 로 재시작할 때 첫 실행 입력에 한 번만 덧붙일 후속 지시. */
  initialFeedback?: string;
  /** cicd 단계의 의도. 기본은 CI만, CD는 명시적으로 요청된 경우에만. */
  deliveryIntent?: 'ci' | 'cd';
  /** 부모 workflow 취소를 현재 실행 중인 child agent에 전달한다. */
  signal?: AbortSignal;
}

export interface StepResult { runId: string; durationMs: number; status: string; }

export interface ClarificationQuestion {
  id: string;
  category: string;
  text: string;
  recommendation: string;
}

export interface ClarificationResult {
  summary: string;
  questions: ClarificationQuestion[];
}

export interface SpecResult {
  workflowRunId: string;
  steps: Record<string, StepResult>;
  totalDurationMs: number;
  verdict?: string;
  clarification?: ClarificationResult;
  /** planner 단계가 산출한 플랜 텍스트 (docs/plan 기록에 사용). */
  planOutput?: string;
  /** review/test 피드백으로 planner·clarifier 로 되돌아간 횟수 */
  routeCount?: number;
  /** skip 모드에서 추천 답안으로 자동 답변한 clarifier 라운드들 (히스토리 편입용). */
  autoClarifyRounds?: Array<{ questions: ClarificationQuestion[]; answers: Record<string, string> }>;
  /** 실행을 멈춘 단계와 실제 에이전트 출력. 부모 spec 요약에 표시한다. */
  failure?: {
    step: string;
    status: string;
    reason: string;
    cause?: 'agent_stopped' | 'invalid_output' | 'route_limit_exhausted' | 'route_target_disabled' | 'route_missing';
    route?: string;
    routeAvailable: boolean;
  };
}

export const STEP_ORDER = AGENT_ORDER;
/** 실제 수정이 진전되는 workflow가 너무 일찍 끊기지 않도록 허용하는 기본 재작업 횟수. */
export const DEFAULT_MAX_ROUTES = 4;
/** 비용 폭주와 무한 라우팅을 막는 절대 상한. */
export const MAX_ROUTE_LIMIT = 10;
export type Step = typeof STEP_ORDER[number];
type RouteTarget = 'planner' | 'clarifier';

/** 출력에서 마지막에 등장한 `[KEY: value]` 마커 값을 소문자로 반환 */
function lastMarker(output: string, re: RegExp): string | undefined {
  const matches = [...output.matchAll(re)];
  return matches.length ? matches[matches.length - 1][1].trim().toLowerCase() : undefined;
}

/** review/test 가 지정한 재작업 대상. planner·clarifier 외에는 라우팅하지 않음. */
function parseRoute(output: string): RouteTarget | undefined {
  const m = lastMarker(output, /\[ROUTE:\s*([^\]]+)\]/gi);
  return m === 'planner' || m === 'clarifier' ? m : undefined;
}

function parseVerdict(output: string): 'SHIP' | 'NEEDS-WORK' | 'BLOCKED' | undefined {
  const m = lastMarker(output, /\[VERDICT:\s*([^\]]+)\]/gi);
  if (!m) return undefined;
  if (m.includes('ship')) return 'SHIP';
  if (m.includes('block')) return 'BLOCKED';
  return 'NEEDS-WORK';
}

function parseTests(output: string): 'PASS' | 'FAIL' | 'BLOCKED' | undefined {
  const m = lastMarker(output, /\[TESTS:\s*([^\]]+)\]/gi);
  if (!m) return undefined;
  if (m.includes('pass')) return 'PASS';
  if (m.includes('block')) return 'BLOCKED';
  return 'FAIL';
}

/** planner strict contract: PLAN block containing 2-8 numbered specialist assignments. */
function isValidPlanOutput(output: string): boolean {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const start = lines.indexOf('PLAN:');
  const end = lines.indexOf('END.', start + 1);
  if (start < 0 || end < 0) return false;
  const steps = lines.slice(start + 1, end).filter(Boolean);
  if (steps.length < 2 || steps.length > 8) return false;
  return steps.every((line, index) =>
    new RegExp(`^${index + 1}\\.\\s*(?:scaffold|test|review|cicd)\\s+\\|\\s+\\S`, 'i').test(line),
  );
}

function extractJsonObjectText(output: string): string {
  const text = output.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  if (candidate.startsWith('{')) return candidate;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
}

function parseClarifierOutput(output: string): { ready: boolean; summary: string; questions: ClarificationQuestion[] } | undefined {
  try {
    const parsed = JSON.parse(extractJsonObjectText(output));
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.ready !== 'boolean') return undefined;
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions.filter((q: any) =>
        q &&
        typeof q.id === 'string' &&
        typeof q.category === 'string' &&
        typeof q.text === 'string' &&
        typeof q.recommendation === 'string',
      )
      : [];
    return {
      ready: parsed.ready,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      questions,
    };
  } catch {
    return undefined;
  }
}

function feedbackBlock(fromStep: Step, output: string): string {
  return `---\n\n## 직전 ${fromStep} 단계 피드백 — 수정 필요\n\n` +
    `아래는 ${fromStep} 단계가 발견한 문제다. 원인을 해소하도록 작업을 갱신하라.\n\n${output.trim()}`;
}

function assignedPlanSteps(planOutput: string | undefined, agent: string): string[] {
  if (!planOutput?.trim()) return [];
  const lines = planOutput.split(/\r?\n/);
  return lines.filter(line => new RegExp(`^\\s*\\d+\\.\\s*${agent}\\s*\\|`, 'i').test(line));
}

export async function runSpec(specContent: string, opts: SpecOptions = {}): Promise<SpecResult> {
  const workflowRunId = opts.workflowRunId ?? randomUUID();
  const stepsFilter = opts.steps ?? new Set<string>(STEP_ORDER);
  const configuredMaxRoutes = opts.maxRoutes ?? opts.iterations ?? DEFAULT_MAX_ROUTES;
  const maxRoutes = Number.isFinite(configuredMaxRoutes)
    ? Math.min(MAX_ROUTE_LIMIT, Math.max(0, Math.floor(configuredMaxRoutes)))
    : DEFAULT_MAX_ROUTES;
  const autoClarify = opts.autoClarify ?? false;
  const configuredClarifyRounds = opts.maxClarifyRounds ?? 0;
  const maxClarifyRounds = configuredClarifyRounds === 0
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor(configuredClarifyRounds));
  const start = Date.now();
  const results: Record<string, StepResult> = {};

  // skip 모드에서 추천 답안으로 자동 답변한 라운드와, 다음 clarifier 입력에 실을 Q&A 라인.
  const autoClarifyRounds: Array<{ questions: ClarificationQuestion[]; answers: Record<string, string> }> = [];
  const autoQaLines: string[] = [];

  const runOpts = { workflowRunId, triggerSource: opts.triggerSource ?? 'cli', cwd: opts.cwd, deliveryIntent: opts.deliveryIntent ?? 'ci', signal: opts.signal };
  const agents: Record<string, (input: string, opts: any) => Promise<RunResult>> = {
    clarifier, planner, scaffold, test, review, cicd,
  };

  const baseSpec = specContent;
  let clarifiedSpec = baseSpec;
  let planOutput: string | undefined = opts.initialPlanOutput;
  const initialFeedback = opts.initialFeedback?.trim();
  let initialFeedbackApplied = false;
  let pendingFeedback: string | undefined;
  let verdict: string | undefined;
  let clarification: ClarificationResult | undefined;
  let routeCount = 0;
  let failure: SpecResult['failure'];

  // planner·clarifier 는 원본 스펙을, 그 외 단계는 planner 산출물(plan)을 입력으로 받는다.
  // 라우팅으로 누적된 피드백이 있으면 뒤에 덧붙인다.
  const inputFor = (step: Step): string => {
    let baseline = step === 'clarifier' ? baseSpec : step === 'planner' ? clarifiedSpec : (planOutput ?? clarifiedSpec);
    if (!initialFeedbackApplied && initialFeedback) {
      baseline = `${initialFeedback}\n\n${baseline}`;
      initialFeedbackApplied = true;
    }
    // skip 모드에서 자동 답변한 Q&A 를 다음 clarifier 라운드 입력에 실어 맥락을 잇는다.
    if (step === 'clarifier' && autoQaLines.length > 0) {
      baseline = `${baseline}\n\n## 이전 Q&A (사용자 의사결정)\n${autoQaLines.join('\n')}`;
    }
    const body = pendingFeedback ? `${baseline}\n\n${pendingFeedback}` : baseline;
    if (step !== 'cicd') return body;
    // cicd receives only its own planner assignment. Passing the entire PLAN
    // makes it see scaffold/test/review work and causes it to reject the run
    // as out of scope.
    const cicdTasks = assignedPlanSteps(planOutput, 'cicd');
    const focused = cicdTasks.length
      ? `${clarifiedSpec}\n\n## Assigned CI/CD tasks\n${cicdTasks.join('\n')}${pendingFeedback ? `\n\n${pendingFeedback}` : ''}`
      : body;
    return decorateCicdInput(focused, runOpts.deliveryIntent);
  };

  const routeTo = (target: RouteTarget, fromStep: Step, output: string): boolean => {
    if (!stepsFilter.has(target) || routeCount >= maxRoutes) return false;
    routeCount++;
    pendingFeedback = feedbackBlock(fromStep, output);
    const targetIndex = STEP_ORDER.indexOf(target);
    for (const staleStep of STEP_ORDER.slice(targetIndex)) delete results[staleStep];
    cursor = targetIndex;
    return true;
  };

  const routeFailure = (route: RouteTarget | undefined, step: Step, output: string): NonNullable<SpecResult['failure']> => {
    const cause = !route
      ? 'route_missing'
      : !stepsFilter.has(route)
        ? 'route_target_disabled'
        : 'route_limit_exhausted';
    const explanation = cause === 'route_missing'
      ? `The ${step} agent requested rework but did not provide a valid planner/clarifier route.`
      : cause === 'route_target_disabled'
        ? `The ${step} agent requested ${route}, but that stage is disabled for this workflow.`
        : `Rework route budget exhausted (${routeCount}/${maxRoutes}). The ${step} agent requested ${route}, but no routes remain.`;
    return {
      step,
      status: step === 'test' ? 'FAIL' : 'NEEDS-WORK',
      cause,
      reason: `${explanation}\n\nAgent output:\n${output.trim() || '(no output)'}`,
      route,
      routeAvailable: false,
    };
  };

  let cursor = opts.startStep ? STEP_ORDER.indexOf(opts.startStep) : 0;
  if (cursor < 0) cursor = 0;
  let executed = 0;
  const routeSafetyCap = STEP_ORDER.length * (maxRoutes + 2);
  const safetyCap = autoClarify && !Number.isFinite(maxClarifyRounds)
    ? Number.POSITIVE_INFINITY
    : routeSafetyCap + (autoClarify ? maxClarifyRounds : 0);

  while (cursor < STEP_ORDER.length) {
    if (opts.signal?.aborted) {
      verdict = 'CANCELLED';
      break;
    }
    const step = STEP_ORDER[cursor];
    if (!stepsFilter.has(step)) { cursor++; continue; }
    // The planner decides whether CI/CD work exists. Do not invoke cicd for
    // ordinary application-only plans; there is no valid task for it.
    if (step === 'cicd' && planOutput?.trim() && assignedPlanSteps(planOutput, 'cicd').length === 0) {
      cursor++;
      continue;
    }
    if (++executed > safetyCap) break;

    const r = await agents[step](inputFor(step), runOpts);
    pendingFeedback = undefined;
    results[step] = { runId: r.runId, durationMs: r.durationMs, status: r.status };

    if (r.status === 'BLOCKED' || r.status === 'FAILED' || r.status === 'CANCELLED') {
      verdict = r.status;
      failure = {
        step,
        status: r.status,
        cause: 'agent_stopped',
        reason: r.output.trim() || `The ${step} agent stopped without an error message.`,
        routeAvailable: false,
      };
      break;
    }

    if (step === 'clarifier') {
      const parsed = parseClarifierOutput(r.output);
      if (parsed) {
        if (!parsed.ready) {
          // skip 모드: 상한 안에서는 추천 답안으로 자동 답변하고 clarifier 를 다시 돈다.
          if (autoClarify && parsed.questions.length > 0 && autoClarifyRounds.length < maxClarifyRounds) {
            const answers: Record<string, string> = {};
            for (const q of parsed.questions) {
              answers[q.id] = q.recommendation;
              autoQaLines.push(`- ${q.id} (${q.category}): ${q.text} → 답: ${q.recommendation}`);
            }
            autoClarifyRounds.push({ questions: parsed.questions, answers });
            continue; // cursor 그대로 → clarifier 재실행 (자동 답변이 입력에 실림)
          }
          clarification = { summary: parsed.summary, questions: parsed.questions };
          results[step] = { runId: r.runId, durationMs: r.durationMs, status: 'NEEDS-CLARIFICATION' };
          verdict = 'NEEDS-CLARIFICATION';
          break;
        }
        if (parsed.summary.trim()) clarifiedSpec = parsed.summary.trim();
      } else {
        verdict = 'BLOCKED';
        results[step] = { runId: r.runId, durationMs: r.durationMs, status: 'BLOCKED' };
        failure = {
          step,
          status: 'BLOCKED',
          cause: 'invalid_output',
          reason: r.output.trim() || 'The clarifier returned an invalid response.',
          routeAvailable: false,
        };
        break;
      }
    }

    if (step === 'planner') {
      if (!isValidPlanOutput(r.output)) {
        verdict = 'BLOCKED';
        results[step] = { runId: r.runId, durationMs: r.durationMs, status: 'BLOCKED' };
        failure = {
          step,
          status: 'BLOCKED',
          cause: 'invalid_output',
          reason: r.output.trim() || 'The planner returned an invalid response.',
          routeAvailable: false,
        };
        break;
      }
      planOutput = r.output;
    }

    // test: 소스 코드 오류로 판정된 실패만 planner/clarifier 로 되돌린다.
    // (테스트 코드 오류는 test 에이전트가 자기 실행 안에서 직접 고친다.)
    if (step === 'test') {
      const tests = parseTests(r.output);
      if (!tests) {
        verdict = 'BLOCKED';
        results[step] = { runId: r.runId, durationMs: r.durationMs, status: 'BLOCKED' };
        failure = {
          step,
          status: 'BLOCKED',
          cause: 'invalid_output',
          reason: r.output.trim() || 'The test agent returned an invalid response.',
          routeAvailable: false,
        };
        break;
      }
      if (tests === 'FAIL') {
        // LLM이 필수 ROUTE 마커를 빠뜨려도 명확한 구현 결함은 planner가 기본 소유한다.
        // 마커 누락만으로 이미 끝난 테스트/리뷰 비용을 버리고 workflow를 중단하지 않는다.
        const route = parseRoute(r.output) ?? 'planner';
        if (routeTo(route, 'test', r.output)) continue;
        verdict = 'FAILED';
        failure = routeFailure(route, 'test', r.output);
        break;
      }
      if (tests === 'BLOCKED') {
        verdict = 'BLOCKED';
        failure = {
          step,
          status: 'BLOCKED',
          cause: 'agent_stopped',
          reason: r.output.trim() || 'The test agent was blocked without providing a reason.',
          routeAvailable: false,
        };
        break;
      }
    }

    // review: 수정 필요(NEEDS-WORK)면 지정한 planner/clarifier 로 즉시 되돌린다.
    if (step === 'review') {
      verdict = parseVerdict(r.output) ?? 'NEEDS-WORK';
      if (verdict === 'SHIP') { cursor++; continue; } // 통과 → cicd 진행
      if (verdict === 'NEEDS-WORK') {
        const route = parseRoute(r.output) ?? 'planner';
        if (routeTo(route, 'review', r.output)) continue;
        failure = routeFailure(route, 'review', r.output);
      } else if (verdict === 'BLOCKED') {
        failure = {
          step,
          status: verdict,
          cause: 'agent_stopped',
          reason: r.output.trim() || 'The review agent was blocked without providing a reason.',
          routeAvailable: false,
        };
      }
      break; // NEEDS-WORK(예산 소진/라우트 없음) 또는 BLOCKED → cicd 미진행, 종료
    }

    cursor++;
  }

  return {
    workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict, clarification, planOutput, routeCount,
    autoClarifyRounds: autoClarifyRounds.length ? autoClarifyRounds : undefined,
    failure,
  };
}

export function workflowRunStatus(result: Pick<SpecResult, 'verdict'>): 'DONE' | 'FAILED' {
  return result.verdict === 'BLOCKED' || result.verdict === 'FAILED' || result.verdict === 'NEEDS-WORK' || result.verdict === 'CANCELLED'
    ? 'FAILED'
    : 'DONE';
}

export function workflowOutput(result: SpecResult): string {
  const stepSummary = Object.entries(result.steps)
    .map(([k, v]) => `${k}: ${v.status}`)
    .join(', ');
  const verdict = result.verdict ? `\nverdict: ${result.verdict}` : '';
  if (!result.failure) return `${stepSummary}${verdict}`;
  const route = result.failure.route
    ? `\nroute: ${result.failure.route} (${result.failure.routeAvailable ? 'available' : 'not available'})`
    : '';
  const cause = result.failure.cause ? `\nfailure cause: ${result.failure.cause}` : '';
  return `${stepSummary}${verdict}\nfailure: ${result.failure.step} (${result.failure.status})${cause}${route}\n` +
    `failure reason:\n${result.failure.reason}`;
}

export function runSpecBackground(specContent: string, opts: SpecOptions = {}): string {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  insertRun({
    id: runId,
    agentName: 'spec',
    input: specContent.slice(0, 4000),
    status: 'RUNNING',
    startedAt,
    triggerSource: opts.triggerSource ?? 'dashboard',
  });

  const wallStart = Date.now();
  runSpec(specContent, { ...opts, workflowRunId: runId }).then(result => {
    const output = result.clarification?.questions.length
      ? `${workflowOutput(result)}\n\n${JSON.stringify(result.clarification, null, 2)}`
      : workflowOutput(result);
    updateRun(runId, {
      output,
      status: workflowRunStatus(result),
      durationMs: result.totalDurationMs,
      ...(result.failure ? { errorType: 'workflow_failure', stopReason: result.failure.step } : {}),
    });
  }).catch(err => {
    updateRun(runId, {
      output: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      status: 'FAILED',
      durationMs: Date.now() - wallStart,
    });
  });

  return runId;
}
