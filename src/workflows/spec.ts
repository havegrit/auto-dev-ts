import { scaffold } from '../agents/scaffold.js';
import { review } from '../agents/review/index.js';
import { test } from '../agents/test.js';
import { cicd } from '../agents/cicd.js';
import { planner } from '../agents/planner.js';
import { clarifier } from '../agents/clarifier.js';
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
  /** review/test 피드백으로 planner·clarifier 로 되돌아간 횟수 */
  routeCount?: number;
}

const STEP_ORDER = ['clarifier', 'planner', 'scaffold', 'test', 'review', 'cicd'] as const;
type Step = typeof STEP_ORDER[number];
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

function parseClarifierOutput(output: string): { ready: boolean; summary: string; questions: ClarificationQuestion[] } | undefined {
  try {
    const parsed = JSON.parse(output);
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
  const start = Date.now();
  const results: Record<string, StepResult> = {};

  const runOpts = { workflowRunId, triggerSource: opts.triggerSource ?? 'cli', cwd: opts.cwd };
  const agents: Record<string, (input: string, opts: any) => Promise<RunResult>> = {
    clarifier, planner, scaffold, test, review, cicd,
  };

  const baseSpec = specContent;
  let clarifiedSpec = baseSpec;
  let planOutput: string | undefined;
  let pendingFeedback: string | undefined;
  let verdict: string | undefined;
  let clarification: ClarificationResult | undefined;
  let routeCount = 0;

  // planner·clarifier 는 원본 스펙을, 그 외 단계는 planner 산출물(plan)을 입력으로 받는다.
  // 라우팅으로 누적된 피드백이 있으면 뒤에 덧붙인다.
  const inputFor = (step: Step): string => {
    const baseline = step === 'clarifier' ? baseSpec : step === 'planner' ? clarifiedSpec : (planOutput ?? clarifiedSpec);
    return pendingFeedback ? `${baseline}\n\n${pendingFeedback}` : baseline;
  };

  const routeTo = (target: RouteTarget, fromStep: Step, output: string): boolean => {
    if (!stepsFilter.has(target) || routeCount >= maxRoutes) return false;
    routeCount++;
    pendingFeedback = feedbackBlock(fromStep, output);
    cursor = STEP_ORDER.indexOf(target);
    return true;
  };

  let cursor = 0;
  let executed = 0;
  const safetyCap = STEP_ORDER.length * (maxRoutes + 2); // 무한 라우팅 방지

  while (cursor < STEP_ORDER.length) {
    const step = STEP_ORDER[cursor];
    if (!stepsFilter.has(step)) { cursor++; continue; }
    if (++executed > safetyCap) break;

    const r = await agents[step](inputFor(step), runOpts);
    pendingFeedback = undefined;
    results[step] = { runId: r.runId, durationMs: r.durationMs, status: r.status };

    if (r.status === 'BLOCKED' || r.status === 'FAILED') {
      verdict = r.status;
      break;
    }

    if (step === 'clarifier') {
      const parsed = parseClarifierOutput(r.output);
      if (parsed) {
        if (!parsed.ready) {
          clarification = { summary: parsed.summary, questions: parsed.questions };
          results[step] = { runId: r.runId, durationMs: r.durationMs, status: 'NEEDS-CLARIFICATION' };
          verdict = 'NEEDS-CLARIFICATION';
          break;
        }
        if (parsed.summary.trim()) clarifiedSpec = parsed.summary.trim();
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

  return { workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict, clarification, routeCount };
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
    const stepSummary = Object.entries(result.steps)
      .map(([k, v]) => `${k}: ${v.status}`)
      .join(', ');
    const output = result.clarification?.questions.length
      ? `${stepSummary}\n\n${JSON.stringify(result.clarification, null, 2)}`
      : stepSummary;
    updateRun(runId, { output, status: 'DONE', durationMs: result.totalDurationMs });
  }).catch(err => {
    updateRun(runId, {
      output: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      status: 'FAILED',
      durationMs: Date.now() - wallStart,
    });
  });

  return runId;
}
