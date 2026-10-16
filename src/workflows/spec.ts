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
import { commitSuccessfulSpec } from './post-success-commit.js';
import { log } from '../lib/logger.js';
import { executeTeam, parseTeamPlan, type TeamExecutionResult } from './team.js';
import { defaultWorkspaceDir } from '../lib/workspace.js';
import { DEFAULT_VERIFY_TIMEOUT_MS, loadProjectConfig, roleBoundaryEnabled } from '../lib/project-config.js';
import { findRoleBoundaryViolations, snapshotWorkspace } from '../lib/role-boundary.js';
import { runVerifyStep, verifyFeedbackBody, VERIFY_AGENT_NAME } from './verify-gate.js';
import { runRuntimeVerification } from './runtime-gate.js';
import { emitRunEvent } from '../lib/run-events.js';

export interface SpecOptions {
  steps?: Set<string>;
  /** 피드백 재작업(라우팅) 허용 횟수. 미지정 시 iterations, 그것도 없으면 DEFAULT_MAX_ROUTES. */
  iterations?: number;
  maxRoutes?: number;
  triggerSource?: string;
  triggerDetail?: string;
  workflowRunId?: string;
  /** clarification 답변 전후 workflow를 묶는 spec 세션 ID. */
  specSessionId?: string;
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
  /** 버그 모드에서 수정 전후에 동일하게 실행할 재현 명령. */
  reproCommand?: string;
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
    cause?: 'agent_stopped' | 'invalid_output' | 'route_limit_exhausted' | 'route_target_disabled' | 'route_missing' | 'skill_unavailable'
      | 'verify_failed' | 'role_boundary_violation' | 'reproduction_failed';
    route?: string;
    routeAvailable: boolean;
  };
  /** planner가 생성한 동적 팀 실행 결과. */
  team?: TeamExecutionResult;
}

export const STEP_ORDER = AGENT_ORDER;
/** 실제 수정이 진전되는 workflow가 너무 일찍 끊기지 않도록 허용하는 기본 재작업 횟수. */
export const DEFAULT_MAX_ROUTES = 4;
/** 비용 폭주와 무한 라우팅을 막는 절대 상한. */
export const MAX_ROUTE_LIMIT = 10;
export type Step = typeof STEP_ORDER[number];
type RouteTarget = 'planner' | 'clarifier';
/**
 * 피드백 출처. 에이전트 단계뿐 아니라 오케스트레이터가 직접 관찰한 결과도
 * 재작업 근거가 되므로 Step 보다 넓다.
 */
type FeedbackSource = Step | 'verify' | 'role-boundary' | 'repro';

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

/** planner strict contract: PLAN block containing 1-8 numbered specialist assignments. */
function isValidPlanOutput(output: string): boolean {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const start = lines.indexOf('PLAN:');
  const end = lines.indexOf('END.', start + 1);
  if (start < 0 || end < 0) return false;
  const steps = lines.slice(start + 1, end).filter(Boolean);
  if (steps.length < 1 || steps.length > 8) return false;
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

function feedbackBlock(fromStep: FeedbackSource, output: string): string {
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

  // 대상 프로젝트가 선언한 검증 방법. 설정 파일이 없으면 undefined 이고,
  // 그때 workflow 는 Phase 1 이전과 완전히 동일하게 동작한다 (경고 이벤트만 추가).
  // 설정이 깨져 있으면 loadProjectConfig 가 던져서 run 을 실패시킨다.
  const projectDir = opts.cwd ?? defaultWorkspaceDir();
  const projectConfig = loadProjectConfig(projectDir);
  const boundaryConfig = roleBoundaryEnabled(projectConfig) ? projectConfig.roleBoundary : undefined;

  // skip 모드에서 추천 답안으로 자동 답변한 라운드와, 다음 clarifier 입력에 실을 Q&A 라인.
  const autoClarifyRounds: Array<{ questions: ClarificationQuestion[]; answers: Record<string, string> }> = [];
  const autoQaLines: string[] = [];

  const runOpts = {
    workflowRunId,
    specSessionId: opts.specSessionId,
    triggerSource: opts.triggerSource ?? 'cli',
    cwd: opts.cwd,
    deliveryIntent: opts.deliveryIntent ?? 'ci',
    signal: opts.signal,
  };
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
  let runtimeEvidenceSummary = '';

  // 구현/테스트 단계는 최종 판정 기준이 되는 명령을 미리 알아야 한다.
  const verifyNotice = projectConfig?.verify
    ? `\n\n## 검증 명령 (오케스트레이터가 직접 실행한다)\n` +
      `- \`${projectConfig.verify.command}\`\n` +
      `- 이 명령의 종료 코드가 최종 판정이다. PASS 를 선언하기 전에 같은 명령을 직접 실행해 0 을 확인하라.`
    : '';
  const runtimeNotice = projectConfig?.runtime
    ? `\n\n## 런타임 검증 설정 (오케스트레이터 소유)\n` +
      `- 기동: \`${projectConfig.runtime.up}\`\n` +
      `- 상태 확인: GET \`${projectConfig.runtime.healthcheck.url}\`\n` +
      `- 결정적 확인: ${projectConfig.runtime.checks.map((check) => `\`${check}\``).join(', ') || '(없음)'}\n` +
      `- 오케스트레이터가 런타임을 기동해 결정적 확인과 독립 verifier를 실행한다.`
    : '';
  const reproNotice = opts.reproCommand
    ? `\n\n## 버그 재현 확인\n- 같은 명령을 수정하지 말고 그대로 실행한다: \`${opts.reproCommand}\`\n` +
      '- 구현 수정 뒤 이 명령은 통과해야 한다. 실패하면 원인과 출력을 보고하고 planner에 수정 요청을 남긴다.'
    : '';

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
    let body = pendingFeedback ? `${baseline}\n\n${pendingFeedback}` : baseline;
    if (step === 'review' && runtimeEvidenceSummary) {
      body += `\n\n## 검증 증거 요약\n${runtimeEvidenceSummary}`;
    }
    if (step === 'scaffold' || step === 'test') return `${body}${verifyNotice}${runtimeNotice}${reproNotice}`;
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

  const routeTo = (target: RouteTarget, fromStep: FeedbackSource, output: string): boolean => {
    if (!stepsFilter.has(target) || routeCount >= maxRoutes) return false;
    routeCount++;
    pendingFeedback = feedbackBlock(fromStep, output);
    const targetIndex = STEP_ORDER.indexOf(target);
    for (const staleStep of STEP_ORDER.slice(targetIndex)) delete results[staleStep];
    if (target === 'planner') {
      for (const key of Object.keys(results)) {
        if (!(STEP_ORDER as readonly string[]).includes(key)) delete results[key];
      }
      runtimeEvidenceSummary = '';
    }
    // verify 는 STEP_ORDER 밖의 내부 단계라 위 루프가 지우지 못한다.
    delete results[VERIFY_AGENT_NAME];
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

    // test 에이전트도 Bash 를 가지므로 프로덕션 소스를 바꿀 수 있다. 프롬프트 금지만으로는
    // 막히지 않으니 실행 전후 내용 해시를 비교해 사후 검사한다.
    const boundaryBefore = step === 'test' && boundaryConfig
      ? await snapshotWorkspace(projectDir)
      : undefined;

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

    if (step === 'test' && boundaryConfig) {
      if (!boundaryBefore) {
        emitRunEvent(r.runId, {
          type: 'warn',
          ts: new Date().toISOString(),
          data: 'role_boundary_skipped: not a git repository',
        });
      } else {
        const boundaryAfter = await snapshotWorkspace(projectDir);
        const violations = boundaryAfter
          ? findRoleBoundaryViolations(boundaryBefore, boundaryAfter, boundaryConfig)
          : [];
        if (violations.length > 0) {
          verdict = 'FAILED';
          results[step] = { runId: r.runId, durationMs: r.durationMs, status: 'FAILED' };
          failure = {
            step,
            status: 'FAILED',
            cause: 'role_boundary_violation',
            reason: 'test 단계가 테스트 경로 밖의 파일을 수정했다. 구현 권한은 scaffold 전용이다.\n\n' +
              violations.map((path) => `- ${path}`).join('\n'),
            routeAvailable: false,
          };
          break;
        }
      }
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

      // 구조화된 팀 계획이 있으면 남은 고정 단계를 동적 DAG로 실행한다.
      // 기존 PLAN만 반환하는 planner는 아래의 legacy 순차 workflow로 fallback한다.
      // 버그 모드는 재현 명령을 test 단계 직후 끼워 넣어야 하므로 고정 순차 루프를 쓴다.
      const teamPlan = opts.reproCommand ? undefined : parseTeamPlan(r.output);
      if (teamPlan) {
        const team = await executeTeam(teamPlan, {
          cwd: projectDir,
          input: clarifiedSpec,
          runOpts,
          maxDepth: 2,
          deferReview: Boolean(projectConfig?.verify || projectConfig?.runtime),
        });
        for (const task of team.tasks) {
          results[task.taskId] = {
            runId: task.run?.runId ?? `${workflowRunId}:${task.taskId}`,
            durationMs: task.run?.durationMs ?? 0,
            status: task.status,
          };
        }
        // 동적 팀의 review는 DAG 실행 중 호출하지 않는다. 통합된 결과가 결정적·런타임
        // 검증을 통과한 뒤에만 별도 review 태스크를 실행한다.
        if (!team.failed && projectConfig?.verify && !opts.signal?.aborted) {
          const gate = await runVerifyStep({
            projectDir,
            verify: projectConfig.verify,
            workflowRunId,
            specSessionId: opts.specSessionId,
            triggerSource: runOpts.triggerSource,
            signal: opts.signal,
          });
          results[VERIFY_AGENT_NAME] = {
            runId: gate.runId,
            durationMs: gate.outcome.durationMs,
            status: gate.passed ? 'DONE' : 'FAILED',
          };
          if (gate.outcome.cancelled) {
            return { workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict: 'CANCELLED', planOutput, routeCount, team };
          }
          if (!gate.passed) {
            const feedback = verifyFeedbackBody(projectConfig.verify, gate.outcome);
            return {
              workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict: 'FAILED', planOutput, routeCount, team,
              failure: { step: VERIFY_AGENT_NAME, status: 'FAILED', cause: 'verify_failed', reason: feedback, route: 'planner', routeAvailable: false },
            };
          }
          runtimeEvidenceSummary = `- deterministic verify: PASS (exit 0, ${gate.outcome.durationMs}ms)` +
            (gate.outcome.outputTail ? `\n  ${gate.outcome.outputTail}` : '');
        }

        if (!team.failed && projectConfig?.runtime && !opts.signal?.aborted) {
          const runtimeGate = await runRuntimeVerification({
            projectDir,
            runtime: projectConfig.runtime,
            workflowRunId,
            specContent: clarifiedSpec,
            specSessionId: opts.specSessionId,
            triggerSource: runOpts.triggerSource,
            signal: opts.signal,
            runOpts,
          });
          results[VERIFY_AGENT_NAME] = {
            runId: runtimeGate.runId,
            durationMs: runtimeGate.records.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0),
            status: runtimeGate.passed ? 'DONE' : 'FAILED',
          };
          runtimeEvidenceSummary = [runtimeEvidenceSummary, runtimeGate.evidenceSummary].filter(Boolean).join('\n');
          if (runtimeGate.cancelled) {
            return { workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict: 'CANCELLED', planOutput, routeCount, team };
          }
          if (runtimeGate.blocked) {
            return {
              workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict: 'BLOCKED', planOutput, routeCount, team,
              failure: { step: VERIFY_AGENT_NAME, status: 'BLOCKED', cause: 'agent_stopped', reason: runtimeGate.feedback, routeAvailable: false },
            };
          }
          if (!runtimeGate.passed) {
            const roleBoundaryViolation = runtimeGate.records.some(record => record.stage === 'verifier' && (record.changedFiles?.length ?? 0) > 0);
            if (roleBoundaryViolation) {
              return {
                workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict: 'FAILED', planOutput, routeCount, team,
                failure: { step: VERIFY_AGENT_NAME, status: 'FAILED', cause: 'role_boundary_violation', reason: runtimeGate.feedback, routeAvailable: false },
              };
            }
            if (routeTo('planner', 'verify', runtimeGate.feedback)) continue;
            return {
              workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict: 'FAILED', planOutput, routeCount, team,
              failure: { step: VERIFY_AGENT_NAME, status: 'FAILED', cause: 'verify_failed', reason: runtimeGate.feedback, route: 'planner', routeAvailable: false },
            };
          }
        }

        if (!team.failed && !opts.signal?.aborted) {
          for (const task of team.deferredReviews ?? []) {
            const reviewInput = `${task.input}\n\n## 검증 증거 요약\n${runtimeEvidenceSummary || '(런타임 검증 설정 없음)'}`;
            const r = await review(reviewInput, { ...runOpts, cwd: projectDir });
            const reviewTask = { taskId: task.id, agent: task.agent, run: r, status: r.status, output: r.output };
            team.tasks.push(reviewTask);
            results[task.id] = { runId: r.runId, durationMs: r.durationMs, status: r.status };
            if (r.status !== 'DONE') {
              team.failed = true;
              team.conflict ??= `Team review failed: ${task.id}`;
            }
          }
        }

        const reviewTasks = team.tasks.filter(task => task.agent === 'review');
        const blockedReview = reviewTasks.find(task => task.run?.status === 'BLOCKED' || task.run?.status === 'CANCELLED');
        const reviewVerdict = reviewTasks.some(task => parseVerdict(task.output) === 'NEEDS-WORK')
          ? 'NEEDS-WORK'
          : blockedReview ? 'BLOCKED' : reviewTasks.map(task => parseVerdict(task.output)).find(Boolean);
        const verdict = team.failed
          ? 'FAILED'
          : reviewVerdict ?? 'SHIP';
        if (!team.failed && verdict === 'NEEDS-WORK') {
          const reviewTask = reviewTasks.find(task => parseVerdict(task.output) === 'NEEDS-WORK')!;
          const route = parseRoute(reviewTask.output) ?? 'planner';
          if (routeTo(route, 'review', reviewTask.output)) continue;
          return {
            workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict, planOutput, routeCount, team,
            failure: routeFailure(route, 'review', reviewTask.output),
          };
        }
        if (!team.failed && verdict === 'BLOCKED') {
          const reviewTask = reviewTasks.find(task => parseVerdict(task.output) === 'BLOCKED');
          return {
            workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict, planOutput, routeCount, team,
            failure: {
              step: reviewTask?.taskId ?? 'review',
              status: 'BLOCKED',
              cause: 'agent_stopped',
              reason: reviewTask?.output || 'The dynamic team review was blocked.',
              routeAvailable: false,
            },
          };
        }
        if (!team.failed && verdict === 'SHIP' && !opts.signal?.aborted) {
          void commitSuccessfulSpec({
            specContent: baseSpec,
            clarifiedSpec,
            planOutput,
            runOpts: {
              ...runOpts,
              workflowRunId: undefined,
              specSessionId: undefined,
              triggerSource: 'background',
              triggerDetail: 'post-success',
              signal: undefined,
            },
          }).catch(err => log.error({ err: err instanceof Error ? err.message : String(err) }, 'Background dynamic-team post-success failed'));
        }
        return {
          workflowRunId,
          steps: results,
          totalDurationMs: Date.now() - start,
          verdict,
          planOutput,
          routeCount,
          team,
          failure: team.failed ? {
            step: team.tasks.find(task => task.status !== 'DONE')?.taskId ?? 'team',
            status: 'FAILED',
            cause: 'agent_stopped',
            reason: team.conflict ?? team.tasks.find(task => task.status !== 'DONE')?.error ?? 'Dynamic team failed.',
            routeAvailable: false,
          } : undefined,
        };
      }
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

      // 버그 모드는 test 마커와 관계없이 매 시도에서 같은 재현 명령을 직접 실행한다.
      if (opts.reproCommand) {
        const repro = await runVerifyStep({
          projectDir,
          verify: { command: opts.reproCommand, timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS },
          workflowRunId,
          specSessionId: opts.specSessionId,
          triggerSource: runOpts.triggerSource,
          triggerDetail: 'bug-reproduction-confirmation',
          expectedOutcome: 'pass',
          signal: opts.signal,
        });
        results.repro = {
          runId: repro.runId,
          durationMs: repro.outcome.durationMs,
          status: repro.passed ? 'DONE' : 'FAILED',
        };
        if (repro.outcome.cancelled) {
          verdict = 'CANCELLED';
          break;
        }
        if (!repro.passed) {
          const feedback = [
            '수정 후에도 동일한 버그 재현 명령이 통과하지 못했다. 출력과 종료 코드를 근거로 구현을 수정하라.',
            '',
            `[REPRO: ${opts.reproCommand}]`,
            `- result: ${repro.outcome.timedOut ? 'timed out' : `exit code ${repro.outcome.exitCode ?? 'signal'}`}`,
            `- duration: ${repro.outcome.durationMs}ms`,
            '',
            '```',
            repro.outcome.outputTail || '(출력 없음)',
            '```',
            ...(tests === 'FAIL' ? ['', '## 테스트 에이전트 보고', r.output.trim()] : []),
          ].join('\n');
          if (routeTo('planner', 'repro', feedback)) continue;
          verdict = 'FAILED';
          failure = {
            step: 'repro',
            status: 'FAIL',
            cause: 'reproduction_failed',
            reason: feedback,
            route: 'planner',
            routeAvailable: false,
          };
          break;
        }
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

      // 여기부터는 tests === 'PASS'. 하지만 PASS 는 에이전트의 자기 보고다.
      // 설정이 있으면 오케스트레이터가 검증 명령을 직접 실행해 종료 코드로 확정한다.
      if (projectConfig?.verify) {
        const gate = await runVerifyStep({
          projectDir,
          verify: projectConfig.verify,
          workflowRunId,
          specSessionId: opts.specSessionId,
          triggerSource: runOpts.triggerSource,
          signal: opts.signal,
        });
        results[VERIFY_AGENT_NAME] = {
          runId: gate.runId,
          durationMs: gate.outcome.durationMs,
          status: gate.passed ? 'DONE' : 'FAILED',
        };
        if (gate.outcome.cancelled) {
          // 사용자 취소는 검증 실패가 아니다. 재작업 예산을 쓰지 않고 그대로 멈춘다.
          verdict = 'CANCELLED';
          break;
        }
        if (gate.passed) {
          runtimeEvidenceSummary = `- deterministic verify: PASS (exit 0, ${gate.outcome.durationMs}ms)` +
            (gate.outcome.outputTail ? `\n  ${gate.outcome.outputTail}` : '');
        }
        if (!gate.passed) {
          const feedback = verifyFeedbackBody(projectConfig.verify, gate.outcome);
          if (routeTo('planner', 'verify', feedback)) continue;
          verdict = 'FAILED';
          failure = {
            step: VERIFY_AGENT_NAME,
            status: 'FAILED',
            cause: 'verify_failed',
            reason: feedback,
            route: 'planner',
            routeAvailable: false,
          };
          break;
        }
      } else {
        emitRunEvent(r.runId, {
          type: 'warn',
          ts: new Date().toISOString(),
          data: 'verify_not_configured',
        });
      }

      if (projectConfig?.runtime) {
        const runtimeGate = await runRuntimeVerification({
          projectDir,
          runtime: projectConfig.runtime,
          workflowRunId,
          specContent: clarifiedSpec,
          specSessionId: opts.specSessionId,
          triggerSource: runOpts.triggerSource,
          signal: opts.signal,
          runOpts,
        });
        results[VERIFY_AGENT_NAME] = {
          runId: runtimeGate.runId,
          durationMs: runtimeGate.records.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0),
          status: runtimeGate.passed ? 'DONE' : 'FAILED',
        };
        runtimeEvidenceSummary = [runtimeEvidenceSummary, runtimeGate.evidenceSummary].filter(Boolean).join('\n');
        if (runtimeGate.cancelled) {
          verdict = 'CANCELLED';
          break;
        }
        if (runtimeGate.blocked) {
          verdict = 'BLOCKED';
          failure = {
            step: VERIFY_AGENT_NAME,
            status: 'BLOCKED',
            cause: 'agent_stopped',
            reason: runtimeGate.feedback,
            routeAvailable: false,
          };
          break;
        }
        if (!runtimeGate.passed) {
          const roleBoundaryViolation = runtimeGate.records.some(record => record.stage === 'verifier' && (record.changedFiles?.length ?? 0) > 0);
          if (roleBoundaryViolation) {
            verdict = 'FAILED';
            failure = {
              step: VERIFY_AGENT_NAME,
              status: 'FAILED',
              cause: 'role_boundary_violation',
              reason: runtimeGate.feedback,
              routeAvailable: false,
            };
            break;
          }
          if (routeTo('planner', 'verify', runtimeGate.feedback)) continue;
          verdict = 'FAILED';
          failure = {
            step: VERIFY_AGENT_NAME,
            status: 'FAILED',
            cause: 'verify_failed',
            reason: runtimeGate.feedback,
            route: 'planner',
            routeAvailable: false,
          };
          break;
        }
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

  // Clarification wait, failure, cancellation, and safety-cap exits are not successful specs.
  // Only a fully traversed workflow may audit docs and create commits.
  if (cursor >= STEP_ORDER.length && executed > 0 && !failure && !clarification && !opts.signal?.aborted) {
    // 문서 점검/커밋은 핵심 spec 결과와 무관한 후처리다. 별도 실행으로 넘겨
    // spec children/status를 오염시키지 않고, review 통과 뒤 백그라운드에서 수행한다.
    void commitSuccessfulSpec({
      specContent: baseSpec,
      clarifiedSpec,
      planOutput,
      runOpts: {
        ...runOpts,
        workflowRunId: undefined,
        specSessionId: undefined,
        triggerSource: 'background',
        triggerDetail: 'post-success',
        signal: undefined,
      },
    }).then((postSuccess) => {
      if (postSuccess.failure) {
        log.error({ step: postSuccess.failure.step, cause: postSuccess.failure.cause }, 'Background post-success agent failed');
      }
    }).catch((err) => {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Background post-success workflow failed');
    });
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
