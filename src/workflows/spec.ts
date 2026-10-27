import { scaffold } from '../agents/scaffold.js';
import { review } from '../agents/review/index.js';
import { test } from '../agents/test.js';
import { cicd } from '../agents/cicd.js';
import { planner } from '../agents/planner.js';
import { clarifier } from '../agents/clarifier.js';
import { AGENT_ORDER, AGENT_SPECS } from '../agents/specs.js';
import { decorateCicdInput } from '../agents/dispatch.js';
import { randomUUID } from 'crypto';
import type { RunResult } from '../lib/runner.js';
import { insertRun, updateRun } from '../store/runs.js';
import { commitSuccessfulSpec } from './post-success-commit.js';
import { log } from '../lib/logger.js';
import { executeTeam, parseTeamPlan, type TeamExecutionResult } from './team.js';
import { defaultWorkspaceDir } from '../lib/workspace.js';
import { DEFAULT_VERIFY_TIMEOUT_MS, loadProjectConfig, roleBoundaryEnabled } from '../lib/project-config.js';
import { findRoleBoundaryViolations, snapshotWorkspace, workspaceHeadSha } from '../lib/role-boundary.js';
import {
  BUILTIN_PROTECTED_GLOBS,
  captureTestIntegrityBaseline,
  effectiveTestGlobs,
  findProtectedPathChanges,
  findTestIntegrityViolations,
  junitRegressionReasons,
  readJUnitReport,
  type JUnitCounts,
  type TestIntegrityBaseline,
} from '../lib/test-integrity.js';
import { runVerifyStep, verifyFeedbackBody, VERIFY_AGENT_NAME } from './verify-gate.js';
import { runRuntimeVerification, type RuntimeGateResult } from './runtime-gate.js';
import type { ClarificationQuestion } from '../lib/clarification-types.js';
import { projectFindingKey, recordOperationalFinding } from '../lib/review-findings.js';
import { emitRunEvent } from '../lib/run-events.js';
import { withAgentModelOverrides } from '../lib/model-config.js';
import { completePullRequestDelivery, type PullRequestDeliveryContext, type PullRequestDeliveryState } from '../lib/pr-delivery.js';

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
  /** PR worktree 설정을 원본 프로젝트에서 읽는다. */
  projectConfigDir?: string;
  /** 사전 검사에서 만든 run 전용 PR worktree. */
  deliveryContext?: PullRequestDeliveryContext;
  /** 전달 단계 변경을 workflow 체크포인트에 반영한다. */
  onDeliveryState?: (stage: string, state: PullRequestDeliveryState) => void | Promise<void>;
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
  /** 재현 명령 제한 시간. 미지정 시 verify 기본 제한 시간을 쓴다. */
  reproTimeoutMs?: number;
  /** cicd 단계의 의도. 기본은 CI만, CD는 명시적으로 요청된 경우에만. */
  deliveryIntent?: 'ci' | 'cd';
  /** 부모 workflow 취소를 현재 실행 중인 child agent에 전달한다. */
  signal?: AbortSignal;
  /** eval 모델 매트릭스를 위한 실행 단위 역할별 모델 ID 오버라이드. */
  agentModels?: Record<string, string>;
  /** 의도된 테스트 수 감소를 허용한다. 보호 경로와 eval 오라클 검사는 우회하지 않는다. */
  allowTestRegression?: boolean;
  /** dashboard spec 재시작용 상태 저장. 일반 workflow 호출은 지정하지 않는다. */
  checkpoint?: {
    initialState?: PersistedSpecCheckpointState;
    recoveredResult?: RunResult;
    onState: (state: PersistedSpecCheckpointState) => void;
  };
}

export interface StepResult { runId: string; durationMs: number; status: string; }

export type { ClarificationQuestion } from '../lib/clarification-types.js';

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
  /** workflow 중 관찰한 무결성 또는 검증자 역할 경계 위반 경로 수. */
  integrityViolations?: number;
  /** skip 모드에서 추천 답안으로 자동 답변한 clarifier 라운드들 (히스토리 편입용). */
  autoClarifyRounds?: Array<{ questions: ClarificationQuestion[]; answers: Record<string, string> }>;
  /** 실행을 멈춘 단계와 실제 에이전트 출력. 부모 spec 요약에 표시한다. */
  failure?: {
    step: string;
    status: string;
    reason: string;
    cause?: 'agent_stopped' | 'invalid_output' | 'route_limit_exhausted' | 'route_target_disabled' | 'route_missing' | 'skill_unavailable'
      | 'verify_failed' | 'role_boundary_violation' | 'reproduction_failed' | 'protected_path_modified'
      | 'test_regression' | 'baseline_red' | 'integrity_unavailable' | 'junit_report_unavailable';
    route?: string;
    routeAvailable: boolean;
  };
  /** planner가 생성한 동적 팀 실행 결과. */
  team?: TeamExecutionResult;
  delivery?: PullRequestDeliveryState;
}

export interface PersistedSpecCheckpointState {
  cursor: number;
  executed: number;
  routeCount: number;
  clarifiedSpec: string;
  planOutput?: string;
  pendingFeedback?: string;
  results: Record<string, StepResult>;
  runtimeEvidenceSummary: string;
  autoClarifyRounds: Array<{ questions: ClarificationQuestion[]; answers: Record<string, string> }>;
  autoQaLines: string[];
  initialFeedbackApplied: boolean;
  activeAction?: string;
  activeStep?: string;
  activeRunId?: string;
  activeInput?: string;
  actionStartedAt?: string;
  beforeSnapshot?: Record<string, string>;
  beforeHeadSha?: string;
  recoveryReason?: string;
  integrityBaseline?: TestIntegrityBaseline;
  integrityViolationCount?: number;
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

async function runSpecInternal(specContent: string, opts: SpecOptions = {}): Promise<SpecResult> {
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
  const checkpointState = opts.checkpoint?.initialState;
  let recoveredResult = opts.checkpoint?.recoveredResult;
  let resumeActionPending = Boolean(checkpointState?.activeAction);
  const results: Record<string, StepResult> = { ...(checkpointState?.results ?? {}) };
  let deliveryState: PullRequestDeliveryState | undefined = opts.deliveryContext?.state;

  // 대상 프로젝트가 선언한 검증 방법. 설정 파일이 없으면 undefined 이고,
  // 그때 workflow 는 Phase 1 이전과 완전히 동일하게 동작한다 (경고 이벤트만 추가).
  // 설정이 깨져 있으면 loadProjectConfig 가 던져서 run 을 실패시킨다.
  const projectDir = opts.cwd ?? defaultWorkspaceDir();
  const projectConfig = loadProjectConfig(opts.projectConfigDir ?? projectDir);
  if (projectConfig?.delivery?.mode === 'pull-request' && !opts.deliveryContext) {
    throw new Error('delivery.mode=pull-request requires a checkpointed PR spec session. Start it from the auto-dev dashboard.');
  }
  if (opts.deliveryContext) {
    const missingSteps = ['planner', 'scaffold', 'test', 'review'].filter(step => !stepsFilter.has(step));
    if (missingSteps.length) throw new Error(`PR delivery requires the full verified workflow; enabled steps are missing: ${missingSteps.join(', ')}.`);
  }
  if (opts.deliveryContext && !opts.checkpoint) {
    throw new Error('PR delivery requires a workflow checkpoint. Start it from the auto-dev dashboard.');
  }
  const findingProject = projectFindingKey(projectDir);
  const boundaryConfig = roleBoundaryEnabled(projectConfig) ? projectConfig.roleBoundary : undefined;
  const testGlobs = effectiveTestGlobs(projectConfig?.roleBoundary?.testGlobs ?? []);
  const protectedGlobs = [...new Set([...BUILTIN_PROTECTED_GLOBS, ...(projectConfig?.protect?.globs ?? [])])];
  let integrityBaseline = checkpointState?.integrityBaseline;
  let integrityViolationCount = checkpointState?.integrityViolationCount ?? 0;

  // skip 모드에서 추천 답안으로 자동 답변한 라운드와, 다음 clarifier 입력에 실을 Q&A 라인.
  const autoClarifyRounds: Array<{ questions: ClarificationQuestion[]; answers: Record<string, string> }> =
    checkpointState?.autoClarifyRounds.map(round => ({ questions: round.questions, answers: { ...round.answers } })) ?? [];
  const autoQaLines: string[] = [...(checkpointState?.autoQaLines ?? [])];

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
  let clarifiedSpec = checkpointState?.clarifiedSpec ?? baseSpec;
  let planOutput: string | undefined = checkpointState?.planOutput ?? opts.initialPlanOutput;
  const initialFeedback = opts.initialFeedback?.trim();
  let initialFeedbackApplied = checkpointState?.initialFeedbackApplied ?? false;
  let pendingFeedback: string | undefined = checkpointState?.pendingFeedback;
  let verdict: string | undefined;
  let clarification: ClarificationResult | undefined;
  let routeCount = checkpointState?.routeCount ?? 0;
  let failure: SpecResult['failure'];
  let runtimeEvidenceSummary = checkpointState?.runtimeEvidenceSummary ?? '';

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

  let cursor = checkpointState?.cursor ?? (opts.startStep ? STEP_ORDER.indexOf(opts.startStep) : 0);
  if (cursor < 0) cursor = 0;
  let executed = checkpointState?.executed ?? 0;
  const publishCheckpoint = (extra: Partial<PersistedSpecCheckpointState> = {}): void => {
    if (!opts.checkpoint) return;
    opts.checkpoint.onState({
      cursor,
      executed,
      routeCount,
      clarifiedSpec,
      planOutput,
      pendingFeedback,
      results: { ...results },
      runtimeEvidenceSummary,
      autoClarifyRounds: autoClarifyRounds.map(round => ({ questions: round.questions, answers: { ...round.answers } })),
      autoQaLines: [...autoQaLines],
      initialFeedbackApplied,
      integrityBaseline,
      integrityViolationCount,
      ...extra,
    });
  };
  const checkpointActionIntent = async (action: string, step: string, input?: string): Promise<void> => {
    if (!opts.checkpoint) return;
    const [workspaceSnapshot, headSha] = await Promise.all([
      snapshotWorkspace(projectDir, [...testGlobs, ...protectedGlobs]),
      workspaceHeadSha(projectDir),
    ]);
    publishCheckpoint({
      activeAction: action,
      activeStep: step,
      activeRunId: undefined,
      activeInput: input,
      actionStartedAt: new Date().toISOString(),
      beforeSnapshot: workspaceSnapshot ? Object.fromEntries(workspaceSnapshot) : undefined,
      beforeHeadSha: headSha,
    });
  };
  const initializeIntegrityBaseline = async (): Promise<{
    cause?: NonNullable<SpecResult['failure']>['cause'];
    reason?: string;
    cancelled?: boolean;
    routed?: boolean;
  }> => {
    if (integrityBaseline) return {};
    if (checkpointState && cursor > STEP_ORDER.indexOf('scaffold')) {
      return {
        cause: 'integrity_unavailable',
        reason: 'Checkpoint has no integrity baseline although a file-writing step already ran; restart the workflow from the beginning.',
      };
    }
    try {
      integrityBaseline = await captureTestIntegrityBaseline(projectDir, testGlobs, protectedGlobs);
    } catch (err) {
      return {
        cause: 'integrity_unavailable',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    if (integrityBaseline.dirtyTestPaths.length > 0) {
      emitRunEvent(workflowRunId, {
        type: 'warn',
        ts: new Date().toISOString(),
        data: `test_integrity_skipped_dirty_at_start: ${integrityBaseline.dirtyTestPaths.join(', ')}`.slice(0, 2_000),
      });
    }
    if (opts.allowTestRegression) {
      emitRunEvent(workflowRunId, {
        type: 'warn',
        ts: new Date().toISOString(),
        data: 'allow_test_regression: true (test-count/skip/deletion checks are waived; protected paths remain enforced)',
      });
    }

    if (projectConfig?.verify?.baseline && !opts.reproCommand) {
      await checkpointActionIntent('verify', 'verify-baseline', projectConfig.verify.command);
      const verifyStartedAt = Date.now();
      const baseline = await runVerifyStep({
        projectDir,
        verify: projectConfig.verify,
        workflowRunId,
        specSessionId: opts.specSessionId,
        triggerSource: runOpts.triggerSource,
        triggerDetail: 'baseline-verification',
        signal: opts.signal,
      });
      results['verify-baseline'] = {
        runId: baseline.runId,
        durationMs: baseline.outcome.durationMs,
        status: baseline.outcome.cancelled ? 'CANCELLED' : baseline.passed ? 'DONE' : 'BLOCKED',
      };
      if (baseline.outcome.cancelled) return { cancelled: true };
      const changes = await inspectIntegrity();
      if (changes && routeIntegrityIssue(changes, baseline.runId, 'verify-baseline') === 'routed') {
        publishCheckpoint({ integrityBaseline, integrityViolationCount });
        return { routed: true };
      }
      if (changes) {
        return {
          cause: changes.kind === 'protected' ? 'protected_path_modified' : 'test_regression',
          reason: `Baseline verification modified guarded files: ${changes.paths.join(', ')}`,
        };
      }
      if (!baseline.passed) {
        return {
          cause: 'baseline_red',
          reason: `Baseline verification failed before planner execution. ${verifyFeedbackBody(projectConfig.verify, baseline.outcome)}`,
        };
      }
      if (projectConfig.verify.report) {
        try {
          const report = await readJUnitReport(projectDir, projectConfig.verify.report, verifyStartedAt);
          if (report.stalePaths.length > 0) {
            emitRunEvent(baseline.runId, {
              type: 'warn',
              ts: new Date().toISOString(),
              data: `junit_report_stale: ${report.stalePaths.join(', ')}`.slice(0, 1_000),
            });
          } else if (report.counts) {
            integrityBaseline = { ...integrityBaseline, junitCounts: report.counts };
            if (report.counts.failures > 0 || report.counts.errors > 0) {
              return {
                cause: 'baseline_red',
                reason: `Baseline JUnit report contains failures/errors: ${report.counts.failures}/${report.counts.errors}.`,
              };
            }
          }
        } catch (err) {
          return {
            cause: 'junit_report_unavailable',
            reason: `Baseline JUnit report could not be read: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    }
    publishCheckpoint({ integrityBaseline });
    return {};
  };
  const inspectIntegrity = async (
    beforeTest?: Record<string, string>,
    afterTest?: Awaited<ReturnType<typeof snapshotWorkspace>>,
  ): Promise<{ kind: 'protected' | 'test'; paths: string[] } | undefined> => {
    if (!integrityBaseline) throw new Error('integrity_unavailable: workflow baseline was not captured');
    const protectedChanges = await findProtectedPathChanges(projectDir, integrityBaseline, protectedGlobs);
    if (protectedChanges.length > 0) return { kind: 'protected', paths: protectedChanges };
    if (opts.allowTestRegression) return undefined;
    const testChanges = await findTestIntegrityViolations(projectDir, integrityBaseline, testGlobs, beforeTest, afterTest);
    return testChanges.length > 0 ? { kind: 'test', paths: testChanges } : undefined;
  };
  const routeIntegrityIssue = (
    issue: { kind: 'protected' | 'test'; paths: string[]; reason?: string },
    runId: string,
    stage: string,
    routeAllowed = true,
  ): 'routed' | 'failed' => {
    const protectedPath = issue.kind === 'protected';
    const cause = protectedPath ? 'protected_path_modified' : 'test_regression';
    const ruleHint = protectedPath ? 'protected path changed during workflow' : 'test suite was weakened during workflow';
    integrityViolationCount += Math.max(1, issue.paths.length);
    publishCheckpoint({ integrityViolationCount });
    for (const file of issue.paths) {
      recordOperationalFinding({
        runId,
        workflowRunId,
        project: findingProject,
        severity: 'high',
        category: 'integrity',
        ruleHint,
        file,
      });
    }
    const feedback = [
      protectedPath
        ? '가드레일 설정 또는 검증 스크립트가 workflow 중 변경됐다. 이 경로는 수정하지 말고 원래 요구를 구현하라.'
        : 'workflow 시작 기준보다 테스트가 약화됐다. 테스트 skip/focus 추가나 삭제를 되돌리고 요구사항을 구현하라.',
      ...(issue.reason ? [`세부 사유: ${issue.reason}`] : []),
      `감지 단계: ${stage}`,
      ...issue.paths.map(path => `- ${path}`),
    ].join('\n');
    if (routeAllowed && routeTo('planner', 'role-boundary', feedback)) return 'routed';
    const terminalStatus = routeAllowed ? 'FAILED' : 'CANCELLED';
    verdict = terminalStatus;
    failure = {
      step: protectedPath ? 'integrity' : 'test-integrity',
      status: terminalStatus,
      cause,
      reason: routeAllowed
        ? `${feedback}\n\nPlanner 재작업 라우트 예산이 소진됐거나 비활성화되어 있다.`
        : `${feedback}\n\n취소된 실행이므로 재작업을 시작하지 않았다.`,
      route: 'planner',
      routeAvailable: false,
    };
    return 'failed';
  };
  const checkIntegrityAtGate = async (
    runId: string,
    stage: string,
    routeAllowed = true,
  ): Promise<'ok' | 'routed' | 'failed' | 'blocked'> => {
    try {
      const issue = await inspectIntegrity();
      return issue ? routeIntegrityIssue(issue, runId, stage, routeAllowed) : 'ok';
    } catch (err) {
      verdict = 'BLOCKED';
      failure = {
        step: 'integrity',
        status: 'BLOCKED',
        cause: 'integrity_unavailable',
        reason: err instanceof Error ? err.message : String(err),
        routeAvailable: false,
      };
      return 'blocked';
    }
  };
  const recordVerifierRoleBoundary = <T extends { stage: string; changedFiles?: string[] }>(
    runId: string,
    records: T[],
  ): string[] => {
    const files = [...new Set(records
      .filter(record => record.stage === 'verifier')
      .flatMap(record => record.changedFiles ?? []))];
    if (files.length === 0) return files;
    integrityViolationCount += files.length;
    publishCheckpoint({ integrityViolationCount });
    for (const file of files) {
      recordOperationalFinding({
        runId,
        workflowRunId,
        project: findingProject,
        severity: 'high',
        category: 'role-boundary',
        ruleHint: 'runtime verifier must not modify workspace files',
        file,
      });
    }
    return files;
  };
  type RuntimeGateDisposition = 'passed' | 'routed' | 'terminal';
  const handleRuntimeGateResult = async (
    runtimeGate: RuntimeGateResult,
    integrityStage: string,
  ): Promise<RuntimeGateDisposition> => {
    results[VERIFY_AGENT_NAME] = {
      runId: runtimeGate.runId,
      durationMs: runtimeGate.records.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0),
      status: runtimeGate.passed ? 'DONE' : 'FAILED',
    };
    runtimeEvidenceSummary = [runtimeEvidenceSummary, runtimeGate.evidenceSummary].filter(Boolean).join('\n');
    const verifierChanges = recordVerifierRoleBoundary(runtimeGate.runId, runtimeGate.records);
    if (verifierChanges.length > 0) {
      verdict = 'FAILED';
      failure = {
        step: VERIFY_AGENT_NAME,
        status: 'FAILED',
        cause: 'role_boundary_violation',
        reason: `runtime verifier modified workspace files: ${verifierChanges.join(', ')}`,
        routeAvailable: false,
      };
      return 'terminal';
    }

    const afterRuntime = await checkIntegrityAtGate(
      runtimeGate.runId,
      integrityStage,
      !runtimeGate.cancelled && !opts.signal?.aborted,
    );
    if (afterRuntime === 'routed') return 'routed';
    if (afterRuntime !== 'ok') return 'terminal';
    if (runtimeGate.cancelled || opts.signal?.aborted) {
      verdict = 'CANCELLED';
      return 'terminal';
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
      return 'terminal';
    }
    if (!runtimeGate.passed) {
      const failedStage = runtimeGate.records.find(record => record.status === 'FAIL')?.stage ?? 'runtime verification';
      recordOperationalFinding({
        runId: runtimeGate.runId,
        workflowRunId,
        project: findingProject,
        severity: 'high',
        category: 'verify',
        ruleHint: `runtime verification failed at ${failedStage}`,
      });
      if (routeTo('planner', 'verify', runtimeGate.feedback)) return 'routed';
      verdict = 'FAILED';
      failure = {
        step: VERIFY_AGENT_NAME,
        status: 'FAILED',
        cause: 'verify_failed',
        reason: runtimeGate.feedback,
        route: 'planner',
        routeAvailable: false,
      };
      return 'terminal';
    }
    return 'passed';
  };
  const inspectJUnitAfterVerify = async (
    verifyStartedAt: number,
    runId: string,
  ): Promise<{ kind: 'protected' | 'test'; paths: string[]; reason?: string } | 'blocked' | undefined> => {
    if (!projectConfig?.verify?.report) return undefined;
    try {
      const report = await readJUnitReport(projectDir, projectConfig.verify.report, verifyStartedAt);
      if (report.stalePaths.length > 0) {
        emitRunEvent(runId, {
          type: 'warn',
          ts: new Date().toISOString(),
          data: `junit_report_stale: ${report.stalePaths.join(', ')}`.slice(0, 1_000),
        });
        return undefined;
      }
      if (!report.counts || !integrityBaseline?.junitCounts) {
        emitRunEvent(runId, {
          type: 'warn',
          ts: new Date().toISOString(),
          data: 'junit_report_comparison_skipped: fresh baseline report was unavailable',
        });
        return undefined;
      }
      const reasons = junitRegressionReasons(integrityBaseline.junitCounts, report.counts).filter((reason) =>
        !opts.allowTestRegression || (!reason.startsWith('test count decreased') && !reason.startsWith('skipped count increased')),
      );
      return reasons.length > 0
        ? { kind: 'test', paths: projectConfig.verify.report.paths, reason: reasons.join('; ') }
        : undefined;
    } catch (err) {
      verdict = 'BLOCKED';
      failure = {
        step: VERIFY_AGENT_NAME,
        status: 'BLOCKED',
        cause: 'junit_report_unavailable',
        reason: `Configured JUnit report could not be read after verify: ${err instanceof Error ? err.message : String(err)}`,
        routeAvailable: false,
      };
      recordOperationalFinding({
        runId,
        workflowRunId,
        project: findingProject,
        severity: 'high',
        category: 'integrity',
        ruleHint: 'configured junit report missing or invalid',
      });
      return 'blocked';
    }
  };
  const commitPostSuccess = async (): Promise<void> => {
    await checkpointActionIntent('delivery', opts.deliveryContext ? 'docs-audit' : 'post-success', clarifiedSpec);
    const postSuccess = await commitSuccessfulSpec({
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
      ...(opts.deliveryContext ? {
        commit: false,
        onStage: async (stage: 'docs-audit' | 'local-commit') => {
          await checkpointActionIntent('delivery', stage, clarifiedSpec);
        },
      } : {}),
    });
    if (postSuccess.failure) {
      log.error({ step: postSuccess.failure.step, cause: postSuccess.failure.cause }, 'Background post-success agent failed');
      if (opts.deliveryContext) {
        deliveryState = { status: 'DELIVERY_PENDING', stage: 'docs-audit', reason: postSuccess.failure.reason };
        await opts.onDeliveryState?.('docs-audit', deliveryState);
      }
      return;
    }
    if (opts.deliveryContext) {
      try {
        deliveryState = await completePullRequestDelivery(opts.deliveryContext, {
          requestSummary: baseSpec,
          verifyCommand: projectConfig?.verify?.command,
          verifyConfigured: Boolean(projectConfig?.verify),
          verifyDurationMs: results[VERIFY_AGENT_NAME]?.durationMs,
          verifySummary: runtimeEvidenceSummary.split(/\r?\n/)
            .map(line => line.match(/^\s*-\s*([^:]+):\s*(PASS|FAIL|BLOCKED)/i))
            .filter((match): match is RegExpMatchArray => Boolean(match))
            .map(match => `${match[1].trim()}: ${match[2].toUpperCase()}`)
            .join('; ') || 'No runtime checks configured.',
          reviewSummary: 'Review verdict: SHIP. See workflow evidence for details.',
        }, async (stage, state) => {
          deliveryState = state;
          await checkpointActionIntent('delivery', stage, JSON.stringify(state));
          await opts.onDeliveryState?.(stage, state);
        });
      } catch (err) {
        deliveryState = {
          status: 'DELIVERY_PENDING',
          stage: opts.deliveryContext.state?.stage ?? 'commit',
          commitSha: opts.deliveryContext.state?.commitSha,
          reason: err instanceof Error ? err.message : String(err),
        };
        await opts.onDeliveryState?.(deliveryState.stage ?? 'commit', deliveryState);
        log.error({ reason: deliveryState.reason }, 'Pull request delivery is pending');
      }
    }
    if (opts.checkpoint) publishCheckpoint({ activeAction: undefined, activeStep: undefined, activeRunId: undefined, activeInput: undefined, actionStartedAt: undefined, beforeSnapshot: undefined, beforeHeadSha: undefined });
  };
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
    if (step !== 'clarifier' && !integrityBaseline) {
      const baseline = await initializeIntegrityBaseline();
      if (baseline.cancelled) {
        verdict = 'CANCELLED';
        break;
      }
      if (baseline.routed) continue;
      if (baseline.cause) {
        if (failure) break;
        verdict = 'BLOCKED';
        failure = {
          step: baseline.cause === 'baseline_red' || baseline.cause === 'junit_report_unavailable' ? 'verify-baseline' : 'integrity',
          status: baseline.cause === 'protected_path_modified' || baseline.cause === 'test_regression' ? 'FAILED' : 'BLOCKED',
          cause: baseline.cause,
          reason: baseline.reason ?? 'Workflow integrity baseline could not be established.',
          routeAvailable: false,
        };
        break;
      }
    }
    // The planner decides whether CI/CD work exists. Do not invoke cicd for
    // ordinary application-only plans; there is no valid task for it.
    if (step === 'cicd' && planOutput?.trim() && assignedPlanSteps(planOutput, 'cicd').length === 0) {
      cursor++;
      continue;
    }
    if (step === 'review') {
      try {
        const issue = await inspectIntegrity();
        if (issue && routeIntegrityIssue(issue, results.test?.runId ?? workflowRunId, 'pre-review') === 'routed') continue;
        if (issue) break;
      } catch (err) {
        verdict = 'BLOCKED';
        failure = {
          step: 'integrity', status: 'BLOCKED', cause: 'integrity_unavailable',
          reason: err instanceof Error ? err.message : String(err), routeAvailable: false,
        };
        break;
      }
    }
    const isResumingAction = resumeActionPending && checkpointState?.activeAction === 'agent' && checkpointState.activeStep === step;
    if (isResumingAction) resumeActionPending = false;
    else if (++executed > safetyCap) break;

    const integrityWritableStep = AGENT_SPECS[step].tools.some((tool) => tool === 'Write' || tool === 'Bash');
    const integrityStepBefore = integrityWritableStep
      ? isResumingAction && checkpointState?.beforeSnapshot
        ? new Map(Object.entries(checkpointState.beforeSnapshot))
        : await snapshotWorkspace(projectDir, [...testGlobs, ...protectedGlobs])
      : undefined;
    if (integrityWritableStep && !integrityStepBefore) {
      verdict = 'BLOCKED';
      failure = {
        step: 'integrity', status: 'BLOCKED', cause: 'integrity_unavailable',
        reason: 'Git snapshot became unavailable before an agent step.', routeAvailable: false,
      };
      break;
    }
    // 파일 쓰기 단계의 테스트·보호 경로 변경을 단계 전후 내용 해시로 사후 검사한다.
    const boundaryBefore = step === 'test' && boundaryConfig
      ? new Map(integrityStepBefore ?? [])
      : undefined;
    let integrityStepAfterSnapshot: Awaited<ReturnType<typeof snapshotWorkspace>> | undefined = undefined;

    const input = inputFor(step);
    const isRecoveredStep = Boolean(
      recoveredResult && isResumingAction,
    );
    let r: RunResult;
    if (isRecoveredStep) {
      r = recoveredResult!;
      // 한 child 결과만 같은 단계 입력으로 소비한다. 이후 재작업은 새 실행이다.
      recoveredResult = undefined;
    } else {
      await checkpointActionIntent('agent', step, input);
      r = await agents[step](input, {
        ...runOpts,
        ...(opts.checkpoint ? {
          onRunStarted: (runId: string) => publishCheckpoint({
            activeAction: 'agent', activeStep: step, activeRunId: runId, activeInput: input,
          }),
        } : {}),
      });
    }
    pendingFeedback = undefined;
    results[step] = { runId: r.runId, durationMs: r.durationMs, status: r.status };

    if (integrityWritableStep) {
      const integrityStepAfter = await snapshotWorkspace(projectDir, [...testGlobs, ...protectedGlobs]);
      integrityStepAfterSnapshot = integrityStepAfter;
      if (!integrityStepAfter) {
        verdict = 'BLOCKED';
        failure = {
          step: 'integrity', status: 'BLOCKED', cause: 'integrity_unavailable',
          reason: 'Git snapshot became unavailable after an agent step.', routeAvailable: false,
        };
        break;
      }
      let issue: { kind: 'protected' | 'test'; paths: string[] } | undefined;
      try {
        issue = await inspectIntegrity(
          integrityStepBefore ? Object.fromEntries(integrityStepBefore) : undefined,
          integrityStepAfter,
        );
      } catch (err) {
        verdict = 'BLOCKED';
        failure = {
          step: 'integrity', status: 'BLOCKED', cause: 'integrity_unavailable',
          reason: err instanceof Error ? err.message : String(err), routeAvailable: false,
        };
        break;
      }
      if (issue) {
        const cancelled = r.status === 'CANCELLED' || opts.signal?.aborted === true;
        if (routeIntegrityIssue(issue, r.runId, step, !cancelled) === 'routed') continue;
        break;
      }
    }

    if (r.status === 'BLOCKED' || r.status === 'FAILED' || r.status === 'CANCELLED' || opts.signal?.aborted) {
      const cancelled = r.status === 'CANCELLED' || opts.signal?.aborted === true;
      const status = cancelled ? 'CANCELLED' : r.status;
      verdict = status;
      failure = {
        step,
        status,
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
        const boundaryAfter = integrityStepAfterSnapshot;
        const violations = boundaryAfter
          ? findRoleBoundaryViolations(boundaryBefore, boundaryAfter, boundaryConfig)
          : [];
        if (violations.length > 0) {
          for (const file of violations) {
            recordOperationalFinding({
              runId: r.runId,
              workflowRunId,
              project: findingProject,
              severity: 'high',
              category: 'role-boundary',
              ruleHint: 'test agent must not modify files outside configured test paths',
              file,
            });
          }
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
        await checkpointActionIntent('team', 'team', r.output);
        const team = await executeTeam(teamPlan, {
          cwd: projectDir,
          input: clarifiedSpec,
          runOpts,
          maxDepth: 2,
          deferReview: true,
        });
        for (const task of team.tasks) {
          results[task.taskId] = {
            runId: task.run?.runId ?? `${workflowRunId}:${task.taskId}`,
            durationMs: task.run?.durationMs ?? 0,
            status: task.status,
          };
        }
        // 동적 팀 review는 통합 후 무결성·결정적·런타임 검사를 통과한 뒤 실행한다.
        try {
          const issue = await inspectIntegrity();
          const routeAllowed = !opts.signal?.aborted;
          if (issue && routeIntegrityIssue(issue, workflowRunId, 'team-integration', routeAllowed) === 'routed') continue;
          if (issue) return {
            workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict, planOutput, routeCount, team,
            integrityViolations: integrityViolationCount,
            ...(failure ? { failure } : {}),
          };
        } catch (err) {
          return {
            workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict: 'BLOCKED', planOutput, routeCount, team,
            integrityViolations: integrityViolationCount,
            failure: {
              step: 'integrity', status: 'BLOCKED', cause: 'integrity_unavailable',
              reason: err instanceof Error ? err.message : String(err), routeAvailable: false,
            },
          };
        }
        if (!team.failed && projectConfig?.verify && !opts.signal?.aborted) {
          const beforeGate = await checkIntegrityAtGate(workflowRunId, 'team-pre-verify');
          if (beforeGate === 'routed') continue;
          if (beforeGate !== 'ok') return {
            workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict, planOutput, routeCount, team,
            integrityViolations: integrityViolationCount,
            ...(failure ? { failure } : {}),
          };
          await checkpointActionIntent('verify', VERIFY_AGENT_NAME, projectConfig.verify.command);
          const verifyStartedAt = Date.now();
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
          const afterGate = await checkIntegrityAtGate(
            gate.runId,
            'team-post-verify',
            !gate.outcome.cancelled && !opts.signal?.aborted,
          );
          if (afterGate === 'routed') continue;
          if (afterGate !== 'ok') return {
            workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict, planOutput, routeCount, team,
            integrityViolations: integrityViolationCount,
            ...(failure ? { failure } : {}),
          };
          if (gate.outcome.cancelled || opts.signal?.aborted) {
            return { workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict: 'CANCELLED', planOutput, routeCount, team, integrityViolations: integrityViolationCount };
          }
          if (!gate.passed) {
            recordOperationalFinding({
              runId: gate.runId,
              workflowRunId,
              project: findingProject,
              severity: 'high',
              category: 'verify',
              ruleHint: `verify command failed: ${projectConfig.verify.command}`,
            });
            const feedback = verifyFeedbackBody(projectConfig.verify, gate.outcome);
            return {
              workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict: 'FAILED', planOutput, routeCount, team,
              integrityViolations: integrityViolationCount,
              failure: { step: VERIFY_AGENT_NAME, status: 'FAILED', cause: 'verify_failed', reason: feedback, route: 'planner', routeAvailable: false },
            };
          }
          runtimeEvidenceSummary = `- deterministic verify: PASS (exit 0, ${gate.outcome.durationMs}ms)` +
            (gate.outcome.outputTail ? `\n  ${gate.outcome.outputTail}` : '');
          const junitIssue = await inspectJUnitAfterVerify(verifyStartedAt, gate.runId);
          if (junitIssue === 'blocked') return {
            workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict: 'BLOCKED', planOutput, routeCount, team,
            integrityViolations: integrityViolationCount,
            ...(failure ? { failure } : {}),
          };
          if (junitIssue) {
            if (routeIntegrityIssue(junitIssue, gate.runId, 'team-verify') === 'routed') continue;
            return {
              workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict, planOutput, routeCount, team,
              integrityViolations: integrityViolationCount,
              ...(failure ? { failure } : {}),
            };
          }
        }

        if (!team.failed && projectConfig?.runtime && !opts.signal?.aborted) {
          const beforeRuntime = await checkIntegrityAtGate(workflowRunId, 'team-pre-runtime');
          if (beforeRuntime === 'routed') continue;
          if (beforeRuntime !== 'ok') return {
            workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict, planOutput, routeCount, team,
            integrityViolations: integrityViolationCount,
            ...(failure ? { failure } : {}),
          };
          await checkpointActionIntent('runtime', 'runtime', projectConfig.runtime.up);
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
          const runtimeDisposition = await handleRuntimeGateResult(runtimeGate, 'team-post-runtime');
          if (runtimeDisposition === 'routed') continue;
          if (runtimeDisposition === 'terminal') return {
            workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict, planOutput, routeCount, team,
            integrityViolations: integrityViolationCount,
            ...(failure ? { failure } : {}),
          };
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
        const teamVerdict = team.failed
          ? 'FAILED'
          : reviewVerdict ?? 'SHIP';
        if (!team.failed && teamVerdict === 'NEEDS-WORK') {
          const reviewTask = reviewTasks.find(task => parseVerdict(task.output) === 'NEEDS-WORK')!;
          const route = parseRoute(reviewTask.output) ?? 'planner';
          if (routeTo(route, 'review', reviewTask.output)) continue;
          return {
            workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict: teamVerdict, planOutput, routeCount, team,
            failure: routeFailure(route, 'review', reviewTask.output),
          };
        }
        if (!team.failed && teamVerdict === 'BLOCKED') {
          const reviewTask = reviewTasks.find(task => parseVerdict(task.output) === 'BLOCKED');
          return {
            workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict: teamVerdict, planOutput, routeCount, team,
            failure: {
              step: reviewTask?.taskId ?? 'review',
              status: 'BLOCKED',
              cause: 'agent_stopped',
              reason: reviewTask?.output || 'The dynamic team review was blocked.',
              routeAvailable: false,
            },
          };
        }
        if (!team.failed && teamVerdict === 'SHIP' && !opts.signal?.aborted && runOpts.triggerSource !== 'eval') {
          if (opts.checkpoint) {
            try { await commitPostSuccess(); } catch (err) {
              log.error({ err: err instanceof Error ? err.message : String(err) }, 'Checkpointed dynamic-team post-success failed');
            }
          } else {
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
        }
        return {
          workflowRunId,
          steps: results,
          totalDurationMs: Date.now() - start,
          verdict: teamVerdict,
          planOutput,
          routeCount,
          integrityViolations: integrityViolationCount,
          team,
          delivery: deliveryState,
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
        await checkpointActionIntent('verify', 'repro', opts.reproCommand);
        const repro = await runVerifyStep({
          projectDir,
          verify: { command: opts.reproCommand, timeoutMs: opts.reproTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS },
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
          recordOperationalFinding({
            runId: repro.runId,
            workflowRunId,
            project: findingProject,
            severity: 'high',
            category: 'verify',
            ruleHint: `bug reproduction command failed after fix: ${opts.reproCommand}`,
          });
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
        const beforeGate = await checkIntegrityAtGate(r.runId, 'pre-verify');
        if (beforeGate === 'routed') continue;
        if (beforeGate !== 'ok') break;
        await checkpointActionIntent('verify', VERIFY_AGENT_NAME, projectConfig.verify.command);
        const verifyStartedAt = Date.now();
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
        // 취소 여부와 관계없이 검증 명령이 보호 파일을 바꾸지 않았는지 확인한다.
        const afterGate = await checkIntegrityAtGate(
          gate.runId,
          'post-verify',
          !gate.outcome.cancelled && !opts.signal?.aborted,
        );
        if (afterGate === 'routed') continue;
        if (afterGate !== 'ok') break;
        if (gate.outcome.cancelled || opts.signal?.aborted) {
          verdict = 'CANCELLED';
          break;
        }
        if (gate.passed) {
          runtimeEvidenceSummary = `- deterministic verify: PASS (exit 0, ${gate.outcome.durationMs}ms)` +
            (gate.outcome.outputTail ? `\n  ${gate.outcome.outputTail}` : '');
        }
        if (!gate.passed) {
          recordOperationalFinding({
            runId: gate.runId,
            workflowRunId,
            project: findingProject,
            severity: 'high',
            category: 'verify',
            ruleHint: `verify command failed: ${projectConfig.verify.command}`,
          });
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
        const junitIssue = await inspectJUnitAfterVerify(verifyStartedAt, gate.runId);
        if (junitIssue === 'blocked') break;
        if (junitIssue) {
          if (routeIntegrityIssue(junitIssue, gate.runId, 'verify-junit') === 'routed') continue;
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
        const beforeRuntime = await checkIntegrityAtGate(r.runId, 'pre-runtime');
        if (beforeRuntime === 'routed') continue;
        if (beforeRuntime !== 'ok') break;
        await checkpointActionIntent('runtime', 'runtime', projectConfig.runtime.up);
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
        const runtimeDisposition = await handleRuntimeGateResult(runtimeGate, 'post-runtime');
        if (runtimeDisposition === 'routed') continue;
        if (runtimeDisposition === 'terminal') break;
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

  publishCheckpoint({
    // 결과가 부모 run에 영속화되기 전의 짧은 구간을 재생해 중복 완료 처리를 하지 않는다.
    activeAction: 'finalize',
    activeStep: 'finalize',
    activeRunId: undefined,
    activeInput: undefined,
    actionStartedAt: undefined,
    beforeSnapshot: undefined,
    beforeHeadSha: undefined,
  });

  // Clarification wait, failure, cancellation, and safety-cap exits are not successful specs.
  // Only a fully traversed workflow may audit docs and create commits.
  if (cursor >= STEP_ORDER.length && executed > 0 && !failure && !clarification && !opts.signal?.aborted && runOpts.triggerSource !== 'eval') {
    // 문서 점검/커밋은 핵심 spec 결과와 무관한 후처리다. 별도 실행으로 넘겨
    // spec children/status를 오염시키지 않고, review 통과 뒤 백그라운드에서 수행한다.
    if (opts.checkpoint) {
      try { await commitPostSuccess(); } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Checkpointed post-success workflow failed');
      }
    } else {
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
  }

  return {
    workflowRunId, steps: results, totalDurationMs: Date.now() - start, verdict, clarification, planOutput, routeCount,
    integrityViolations: integrityViolationCount,
    autoClarifyRounds: autoClarifyRounds.length ? autoClarifyRounds : undefined,
    failure,
    delivery: deliveryState,
  };
}

export function runSpec(specContent: string, opts: SpecOptions = {}): Promise<SpecResult> {
  return withAgentModelOverrides(opts.agentModels, () => runSpecInternal(specContent, opts));
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
