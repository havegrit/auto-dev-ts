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
  /** 피드백 재작업(라우팅) 허용 횟수. 미지정 시 iterations, 그것도 없으면 2. */
  iterations?: number;
  maxRoutes?: number;
  triggerSource?: string;
  triggerDetail?: string;
  workflowRunId?: string;
  cwd?: string;
  /** skip 모드: clarifier 질문을 AI 추천 답안으로 자동 답변해 멈추지 않고 진행한다. */
  autoClarify?: boolean;
  /** autoClarify 시 자동 답변을 반복할 최대 라운드 수 (초과하면 사용자에게 질문 넘김). 기본 3. */
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
}

export const STEP_ORDER = AGENT_ORDER;
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

export async function runSpec(specContent: string, opts: SpecOptions = {}): Promise<SpecResult> {
  const workflowRunId = opts.workflowRunId ?? randomUUID();
  const stepsFilter = opts.steps ?? new Set<string>(STEP_ORDER);
  const maxRoutes = opts.maxRoutes ?? opts.iterations ?? 2;
  const autoClarify = opts.autoClarify ?? false;
  const maxClarifyRounds = opts.maxClarifyRounds ?? 3;
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
    return step === 'cicd' ? decorateCicdInput(body, runOpts.deliveryIntent) : body;
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

  let cursor = opts.startStep ? STEP_ORDER.indexOf(opts.startStep) : 0;
  if (cursor < 0) cursor = 0;
  let executed = 0;
  const safetyCap = STEP_ORDER.length * (maxRoutes + 2); // 무한 라우팅 방지

  while (cursor < STEP_ORDER.length) {
    if (opts.signal?.aborted) {
      verdict = 'CANCELLED';
      break;
    }
    const step = STEP_ORDER[cursor];
    if (!stepsFilter.has(step)) { cursor++; continue; }
    if (++executed > safetyCap) break;

    const r = await agents[step](inputFor(step), runOpts);
    pendingFeedback = undefined;
    results[step] = { runId: r.runId, durationMs: r.durationMs, status: r.status };

    if (r.status === 'BLOCKED' || r.status === 'FAILED' || r.status === 'CANCELLED') {
      verdict = r.status;
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
        break;
      }
    }

    if (step === 'planner' && r.output) planOutput = r.output;

    // test: 소스 코드 오류로 판정된 실패만 planner/clarifier 로 되돌린다.
    // (테스트 코드 오류는 test 에이전트가 자기 실행 안에서 직접 고친다.)
    if (step === 'test' && parseTests(r.output) === 'FAIL') {
      const route = parseRoute(r.output);
      if (route && routeTo(route, 'test', r.output)) continue;
    }

    // review: 수정 필요(NEEDS-WORK)면 지정한 planner/clarifier 로 즉시 되돌린다.
    if (step === 'review') {
      verdict = parseVerdict(r.output) ?? 'NEEDS-WORK';
      if (verdict === 'SHIP') { cursor++; continue; } // 통과 → cicd 진행
      if (verdict === 'NEEDS-WORK') {
        const route = parseRoute(r.output);
        if (route && routeTo(route, 'review', r.output)) continue;
      }
      break; // NEEDS-WORK(예산 소진/라우트 없음) 또는 BLOCKED → cicd 미진행, 종료
    }

    cursor++;
  }

  return {
    workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict, clarification, planOutput, routeCount,
    autoClarifyRounds: autoClarifyRounds.length ? autoClarifyRounds : undefined,
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
  return result.verdict ? `${stepSummary}\nverdict: ${result.verdict}` : stepSummary;
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
    updateRun(runId, { output, status: workflowRunStatus(result), durationMs: result.totalDurationMs });
  }).catch(err => {
    updateRun(runId, {
      output: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      status: 'FAILED',
      durationMs: Date.now() - wallStart,
    });
  });

  return runId;
}
