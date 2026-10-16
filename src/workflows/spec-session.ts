import { randomUUID } from 'crypto';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { runSpec, workflowOutput, workflowRunStatus, STEP_ORDER, type PersistedSpecCheckpointState, type SpecResult, type Step } from './spec.js';
import { composeClarifierInput, renderPlanDoc, planSlug, type ClarificationRound } from './clarification.js';
import { getRun, getRunsByWorkflowId, insertRun, updateRun, type RunRow } from '../store/runs.js';
import { saveClarificationState, getClarificationState, type ClarificationState } from '../store/clarification.js';
import { closeEmitter, emitRunEvent } from '../lib/run-events.js';
import { registerRunCancellation } from '../lib/run-cancellation.js';
import { notifyOpenClawSpec } from '../integrations/openclaw/notify.js';
import { AGENT_SPECS } from '../agents/specs.js';
import { loadProjectConfig } from '../lib/project-config.js';
import { autoMergePolicyFingerprint } from '../lib/auto-merge-policy.js';
import { deniedAutoMergeDryRun, evaluateAutoMergeDryRun, type AutoMergeDryRunResult, type AutoMergeWorkflowEvidence } from '../lib/auto-merge.js';
import { modelConfig } from '../lib/model-config.js';
import { readWorkflowEvidence } from '../lib/evidence.js';
import { recordAutoMergeDryRun } from '../store/auto-merge.js';
import { snapshotWorkspace, workspaceHeadSha } from '../lib/role-boundary.js';
import { completePullRequestDelivery, preparePullRequestWorktree, validatePullRequestDeliveryContext, type PullRequestDeliveryContext, type PullRequestDeliveryState, type PullRequestDescription } from '../lib/pr-delivery.js';
import { commitSuccessfulSpec } from './post-success-commit.js';
import { VERIFY_AGENT_NAME } from './verify-gate.js';
import type { RunResult } from '../lib/runner.js';
import {
  claimExpiredWorkflowCheckpoint,
  claimWorkflowDeliveryRetry,
  createCheckpointLeaseOwner,
  createWorkflowCheckpoint,
  finishWorkflowCheckpoint,
  heartbeatWorkflowCheckpoint,
  getWorkflowCheckpoint,
  listExpiredWorkflowCheckpoints,
  updateWorkflowCheckpoint,
  type WorkflowCheckpoint,
  type WorkflowCheckpointSnapshot,
  type WorkflowCheckpointState,
} from '../store/workflow-checkpoints.js';

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

export interface DeliveryRetryHandle {
  done: Promise<void>;
}

export interface ResumeSpecSessionOptions {
  autoClarify?: boolean;
  maxClarifyRounds?: number;
}

interface SpecCheckpointSnapshot extends WorkflowCheckpointSnapshot {
  kind: 'dashboard-spec-session';
  workflowRunId: string;
  configFingerprint: string;
  sessionState: ClarificationState;
  specInput: string;
  options: Omit<SpecSessionOptions, 'steps'> & { steps?: string[] };
  workflowState: PersistedSpecCheckpointState;
  autoMergePolicyFingerprint?: string;
  autoMergeEnabledAtStart?: boolean;
  autoMergeEvidence?: AutoMergeWorkflowEvidence;
  autoMergeDryRun?: AutoMergeDryRunResult;
  finalResult?: {
    verdict?: string;
    failure?: SpecResult['failure'];
    delivery?: PullRequestDeliveryState;
    autoMergeEvidence?: AutoMergeWorkflowEvidence;
    autoMergeDryRun?: AutoMergeDryRunResult;
  };
}

interface CheckpointRuntime {
  workflowRunId: string;
  leaseOwner: string;
  revision: number;
  snapshot: SpecCheckpointSnapshot;
  workflowState: PersistedSpecCheckpointState;
}

function gitWorkspaceBaseline(cwd: string, requireClean: boolean): { head: string; snapshot: Record<string, string> } {
  try {
    const head = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const status = execFileSync('git', ['-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!head) throw new Error('HEAD를 확인할 수 없습니다.');
    if (requireClean && status) throw new Error('미커밋 변경이 있습니다. 작업 트리를 정리한 뒤 다시 시작하세요.');
    const records = status.split('\0').filter(Boolean);
    const snapshot: Record<string, string> = {};
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.length < 4) continue;
      const path = record.slice(3);
      try {
        snapshot[path] = createHash('sha1').update(readFileSync(join(cwd, path))).digest('hex');
      } catch {
        snapshot[path] = '<deleted>';
      }
      if (record.slice(0, 2).includes('R') || record.slice(0, 2).includes('C')) i++;
    }
    return { head, snapshot };
  } catch (err) {
    if (err instanceof Error && err.message.includes('미커밋')) throw err;
    throw new Error(`체크포인트 워크플로우에는 Git 작업 트리가 필요합니다: ${cwd}`);
  }
}

function runtimeSnapshot(runtime: CheckpointRuntime): SpecCheckpointSnapshot {
  return { ...runtime.snapshot, ...runtime.workflowState, workflowState: runtime.workflowState };
}

function persistCheckpointState(runtime: CheckpointRuntime, state: PersistedSpecCheckpointState): void {
  runtime.workflowState = state;
  runtime.snapshot = runtimeSnapshot(runtime);
  runtime.revision = updateWorkflowCheckpoint(
    runtime.workflowRunId, runtime.snapshot, 'RUNNING', runtime.leaseOwner, runtime.revision,
  );
}

function persistDeliveryState(runtime: CheckpointRuntime, stage: string, state: PullRequestDeliveryState): void {
  const context = runtime.snapshot.sessionState.deliveryContext;
  if (context) context.state = state;
  runtime.snapshot = {
    ...runtimeSnapshot(runtime),
    ...(context ? { deliveryContext: context, sessionState: { ...runtime.snapshot.sessionState, deliveryContext: context } } : {}),
    deliveryState: state,
  };
  runtime.workflowState = {
    ...runtime.workflowState,
    activeAction: 'delivery',
    activeStep: stage,
    activeRunId: undefined,
    activeInput: JSON.stringify(state),
    actionStartedAt: new Date().toISOString(),
  };
  runtime.snapshot = runtimeSnapshot(runtime);
  runtime.revision = updateWorkflowCheckpoint(
    runtime.workflowRunId, runtime.snapshot, 'RUNNING', runtime.leaseOwner, runtime.revision,
  );
}

function finishCheckpoint(
  workflowRunId: string,
  runtime: CheckpointRuntime,
  state: WorkflowCheckpointState,
  runPatch: Parameters<typeof finishWorkflowCheckpoint>[5],
  extra: Partial<SpecCheckpointSnapshot> = {},
): void {
  const retainAction = state === 'RECOVERY_REQUIRED';
  runtime.snapshot = {
    ...runtimeSnapshot(runtime),
    ...extra,
    activeAction: retainAction ? runtime.workflowState.activeAction : undefined,
    activeStep: retainAction ? runtime.workflowState.activeStep : undefined,
    activeRunId: retainAction ? runtime.workflowState.activeRunId : undefined,
    activeInput: retainAction ? runtime.workflowState.activeInput : undefined,
    recoveryReason: extra.recoveryReason,
    finalResult: extra.finalResult,
  };
  runtime.revision = finishWorkflowCheckpoint(
    workflowRunId, runtime.snapshot, state, runtime.leaseOwner, runtime.revision, runPatch,
  );
}

function parseLeaseOwner(value?: string): { host: string; pid: number } | undefined {
  try {
    const owner = JSON.parse(value ?? '') as { host?: unknown; pid?: unknown };
    if (typeof owner.host !== 'string' || typeof owner.pid !== 'number' || !Number.isInteger(owner.pid)) return undefined;
    return { host: owner.host, pid: owner.pid };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sameSnapshot(current: Map<string, string> | undefined, expected?: Record<string, string>): boolean {
  if (!current || !expected) return false;
  const actual = Object.fromEntries(current);
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) =>
    key === expectedKeys[index] && actual[key] === expected[key],
  );
}

function toRunResult(run: RunRow): RunResult {
  const status: RunResult['status'] = run.status === 'DONE'
    ? 'DONE'
    : run.status === 'BLOCKED'
      ? 'BLOCKED'
      : run.error_type === 'user_cancelled'
        ? 'CANCELLED'
        : 'FAILED';
  return {
    runId: run.id,
    output: run.output ?? '',
    tokensIn: run.tokens_in ?? 0,
    tokensOut: run.tokens_out ?? 0,
    durationMs: run.duration_ms ?? 0,
    status,
  };
}

function currentChildForCheckpoint(checkpoint: WorkflowCheckpoint, snapshot: SpecCheckpointSnapshot): RunRow | undefined {
  const runId = typeof snapshot['activeRunId'] === 'string' ? snapshot['activeRunId'] : undefined;
  if (runId) return getRun(runId);
  const step = typeof snapshot['activeStep'] === 'string' ? snapshot['activeStep'] : undefined;
  const startedAt = typeof snapshot['actionStartedAt'] === 'string' ? Date.parse(snapshot['actionStartedAt']) : NaN;
  if (!step || !Number.isFinite(startedAt)) return undefined;
  return getRunsByWorkflowId(checkpoint.workflowRunId)
    .filter((run) => run.agent_name === step && Date.parse(run.started_at) >= startedAt)
    .at(-1);
}

function createCheckpointRuntime(
  checkpoint: WorkflowCheckpoint,
  leaseOwner: string,
  snapshot: SpecCheckpointSnapshot,
): CheckpointRuntime {
  const workflowState = (snapshot['workflowState'] && typeof snapshot['workflowState'] === 'object')
    ? snapshot['workflowState'] as PersistedSpecCheckpointState
    : {
      cursor: 0, executed: 0, routeCount: 0,
      clarifiedSpec: typeof (snapshot['sessionState'] as ClarificationState | undefined)?.spec === 'string'
        ? (snapshot['sessionState'] as ClarificationState).spec : '',
      results: {}, runtimeEvidenceSummary: '', autoClarifyRounds: [], autoQaLines: [], initialFeedbackApplied: false,
    };
  return { workflowRunId: checkpoint.workflowRunId, leaseOwner, revision: checkpoint.revision, snapshot, workflowState };
}

function rootRunDuration(runId: string): number {
  const run = getRun(runId);
  const start = run ? Date.parse(run.started_at) : Date.now();
  return Math.max(0, Date.now() - (Number.isFinite(start) ? start : Date.now()));
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

  if (prev.deliveryContext?.state?.status === 'DELIVERY_PENDING') {
    throw new Error('Retry the pending PR delivery before continuing this workflow.');
  }

  const text = instruction.trim();
  const rounds: ClarificationRound[] = text
    ? [...prev.rounds.map((r) => ({ ...r })), { questions: [], followup: text }]
    : [...prev.rounds.map((r) => ({ ...r }))];
  const newPullRequest = prev.deliveryContext &&
    (prev.deliveryContext.state?.status === 'DELIVERED' || prev.deliveryContext.state?.status === 'NO_CHANGES');
  const state: ClarificationState = {
    ...prev,
    sessionId: prev.sessionId ?? parentRunId,
    rounds,
    ...(newPullRequest ? {
      cwd: prev.sourceCwd ?? prev.cwd,
      sourceCwd: prev.sourceCwd ?? prev.cwd,
      deliveryContext: undefined,
    } : {}),
  };
  return launch(state, {
    project: prev.project,
    cwd: state.cwd,
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
  let sessionState: ClarificationState = { ...state, sessionId: state.sessionId ?? runId };
  const sessionOpts = { ...opts, triggerSource: opts.triggerSource ?? 'dashboard' };
  const sourceCwd = sessionState.sourceCwd ?? sessionState.cwd;
  let projectConfig: ReturnType<typeof loadProjectConfig>;
  try {
    projectConfig = loadProjectConfig(sourceCwd);
  } catch {
    // 설정 오류는 runSpec 내부에서 기존처럼 부모 run 실패로 기록한다.
  }
  const prMode = projectConfig?.delivery?.mode === 'pull-request';
  const autoMergeModels = prMode ? modelConfig.getAgentModels() : undefined;
  const autoMergeFingerprint = prMode && autoMergeModels
    ? autoMergePolicyFingerprint(projectConfig, autoMergeModels, {
      effort: modelConfig.getEffort(),
      fallbackModel: modelConfig.getFallbackModel(),
    })
    : undefined;
  if (prMode) {
    const missingSteps = ['planner', 'scaffold', 'test', 'review'].filter(step => sessionOpts.steps && !sessionOpts.steps.has(step));
    if (missingSteps.length) throw new Error(`PR delivery requires the full verified workflow; enabled steps are missing: ${missingSteps.join(', ')}.`);
    const deliveryContext: PullRequestDeliveryContext = sessionState.deliveryContext
      ? { ...sessionState.deliveryContext, dashboardRunId: runId }
      : preparePullRequestWorktree(sourceCwd, runId, projectConfig!.delivery!, process.env);
    deliveryContext.dashboardRunId = runId;
    if (sessionState.deliveryContext) validatePullRequestDeliveryContext(deliveryContext, process.env);
    sessionState = {
      ...sessionState,
      sourceCwd,
      cwd: deliveryContext.worktreeDir,
      deliveryContext,
    };
  } else if (sessionState.deliveryContext) {
    throw new Error('PR delivery 설정이 제거되어 저장된 PR worktree를 이어갈 수 없습니다.');
  }
  const input = composeClarifierInput(sessionState.spec, sessionState.rounds);
  const checkpointEnabled = prMode || (sessionOpts.triggerSource === 'dashboard' && projectConfig?.workflow?.resumeOnRestart === true);
  let checkpointRuntime: CheckpointRuntime | undefined;
  let pendingCheckpoint: { leaseOwner: string; snapshot: SpecCheckpointSnapshot } | undefined;
  if (checkpointEnabled) {
    const baseline = gitWorkspaceBaseline(sessionState.cwd, !prMode);
    const leaseOwner = createCheckpointLeaseOwner();
    const initialState: PersistedSpecCheckpointState = {
      cursor: Math.max(0, resume ? STEP_ORDER.indexOf(resume.startStep) : 0),
      executed: 0,
      routeCount: 0,
      clarifiedSpec: input,
      planOutput: sessionState.planOutput,
      results: {},
      runtimeEvidenceSummary: '',
      autoClarifyRounds: [],
      autoQaLines: [],
      initialFeedbackApplied: false,
    };
    const checkpointSnapshot: SpecCheckpointSnapshot = {
      kind: 'dashboard-spec-session',
      workflowRunId: runId,
      configFingerprint: createHash('sha256').update(JSON.stringify(projectConfig)).digest('hex'),
      ...(autoMergeFingerprint ? { autoMergePolicyFingerprint: autoMergeFingerprint } : {}),
      ...(prMode ? { autoMergeEnabledAtStart: projectConfig?.delivery?.autoMerge?.enabled === true } : {}),
      sessionState,
      ...(sessionState.deliveryContext ? { deliveryContext: sessionState.deliveryContext, deliveryState: sessionState.deliveryContext.state } : {}),
      specInput: input,
      options: {
        ...sessionOpts,
        cwd: sessionState.cwd,
        steps: serializeSteps(sessionOpts.steps),
      },
      workflowState: initialState,
      ...initialState,
      baseHeadSha: baseline.head,
      baseSnapshot: baseline.snapshot,
    };
    pendingCheckpoint = { leaseOwner, snapshot: checkpointSnapshot };
  }
  mkdirSync(sessionState.cwd, { recursive: true });
  insertRun({
    id: runId,
    agentName: 'spec',
    input: input.slice(0, 4000),
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    triggerSource: sessionOpts.triggerSource,
    triggerDetail: sessionOpts.triggerDetail,
    specSessionId: sessionState.sessionId,
  });
  // 모든 spec run 의 상태를 영속화해 나중에 후속 수정 지시로 이어갈 수 있게 한다.
  // (게이트에서 멈추면 finalize 가 질문 라운드를 더해 다시 저장한다.)
  saveClarificationState(runId, sessionState);
  if (pendingCheckpoint) {
    try {
      const created = createWorkflowCheckpoint(runId, pendingCheckpoint.snapshot, pendingCheckpoint.leaseOwner);
      checkpointRuntime = createCheckpointRuntime(created, pendingCheckpoint.leaseOwner, pendingCheckpoint.snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateRun(runId, { status: 'FAILED', output: `[checkpoint_init_failed] ${message}`, errorType: 'workflow_checkpoint_failed' });
      throw err;
    }
  }

  const abortController = new AbortController();
  const unregisterCancellation = registerRunCancellation(runId, abortController);
  const heartbeat = checkpointRuntime
    ? setInterval(() => {
      if (!heartbeatWorkflowCheckpoint(runId, checkpointRuntime!.leaseOwner, checkpointRuntime!.revision)) {
        abortController.abort(new Error('workflow checkpoint lease lost'));
      }
    }, 20_000)
    : undefined;
  heartbeat?.unref();
  const done = finalize(runId, sessionState, sessionOpts, input, resume, abortController.signal, checkpointRuntime)
    .finally(() => {
      if (heartbeat) clearInterval(heartbeat);
      unregisterCancellation();
    });
  return { runId, done };
}

let checkpointRecoveryTimer: NodeJS.Timeout | undefined;
let checkpointRecoveryRunning = false;

/** lease가 만료된 체크포인트를 한 번씩 검사한다. 서버 기동 때 호출한다. */
export function startWorkflowCheckpointRecovery(): void {
  if (checkpointRecoveryTimer) return;
  void recoverExpiredWorkflowCheckpoints();
  checkpointRecoveryTimer = setInterval(() => { void recoverExpiredWorkflowCheckpoints(); }, 10_000);
  checkpointRecoveryTimer.unref();
}

export async function recoverExpiredWorkflowCheckpoints(): Promise<number> {
  if (checkpointRecoveryRunning) return 0;
  checkpointRecoveryRunning = true;
  let recovered = 0;
  try {
    for (const candidate of listExpiredWorkflowCheckpoints()) {
      try {
        if (await recoverExpiredCheckpoint(candidate)) recovered++;
      } catch (err) {
        console.error(`workflow checkpoint recovery failed for ${candidate.workflowRunId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    checkpointRecoveryRunning = false;
  }
  return recovered;
}

async function recoverExpiredCheckpoint(candidate: WorkflowCheckpoint): Promise<boolean> {
  const priorOwner = parseLeaseOwner(candidate.leaseOwner);
  // lease 만료만으로 소유 프로세스가 멈췄다고 단정할 수 없다. 살아 있는 로컬 owner와
  // 경합하지 않도록 claim을 미루고, 다음 recovery pass에서 다시 확인한다.
  if (priorOwner?.host === hostname() && processIsAlive(priorOwner.pid)) return false;
  const leaseOwner = createCheckpointLeaseOwner();
  const claimed = claimExpiredWorkflowCheckpoint(candidate.workflowRunId, leaseOwner, candidate.revision);
  if (!claimed) return false;

  const snapshot = claimed.snapshot as SpecCheckpointSnapshot;
  const runtime = createCheckpointRuntime(claimed, leaseOwner, snapshot);
  let recoveryReason: string | undefined;
  let recoveredResult: RunResult | undefined;
  let deliveryRecoveryStage: string | undefined;

  if (claimed.schemaVersion !== 1 || snapshot.kind !== 'dashboard-spec-session') {
    recoveryReason = `지원하지 않는 체크포인트 형식입니다 (schema ${claimed.schemaVersion}).`;
  } else if (!priorOwner || priorOwner.host !== hostname()) {
    recoveryReason = '이전 실행의 호스트 소유권을 확인할 수 없어 자동 재개하지 않았습니다.';
  }

  if (!recoveryReason) {
    try {
      const config = loadProjectConfig(snapshot.sessionState.sourceCwd ?? snapshot.sessionState.cwd);
      const fingerprint = createHash('sha256').update(JSON.stringify(config ?? null)).digest('hex');
      if (config?.workflow?.resumeOnRestart !== true && config?.delivery?.mode !== 'pull-request') {
        recoveryReason = '프로젝트 설정에서 workflow.resumeOnRestart 또는 delivery.mode=pull-request가 더 이상 활성화되어 있지 않습니다.';
      } else if (fingerprint !== snapshot.configFingerprint) {
        recoveryReason = '실행 중 프로젝트 설정이 바뀌어 저장된 워크플로우를 재현할 수 없습니다.';
      } else if (config?.delivery?.mode === 'pull-request') {
        if (!snapshot.sessionState.deliveryContext) throw new Error('PR delivery worktree context is missing.');
        validatePullRequestDeliveryContext(snapshot.sessionState.deliveryContext, process.env);
      }
    } catch (err) {
      recoveryReason = `프로젝트 설정을 읽을 수 없습니다: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const workflowState = runtime.workflowState;
  if (!recoveryReason && workflowState.activeAction === 'agent') {
    if (!workflowState.activeStep || !STEP_ORDER.includes(workflowState.activeStep as Step)) {
      recoveryReason = '진행 중이던 에이전트 단계를 확인할 수 없습니다.';
    } else {
      const child = currentChildForCheckpoint(claimed, snapshot);
      if (child && (child.status === 'DONE' || child.status === 'BLOCKED' || (child.status === 'FAILED' && child.error_type !== 'server_restart'))) {
        recoveredResult = toRunResult(child);
      } else if (child?.status === 'RUNNING') {
        recoveryReason = '중단된 에이전트 child run의 종료를 확인할 수 없습니다.';
      } else if (AGENT_SPECS[workflowState.activeStep].tools.some((tool) => tool === 'Write' || tool === 'Bash')) {
        recoveryReason = `중단된 ${workflowState.activeStep} 단계는 파일 쓰기 권한이 있어 자동 재실행하지 않았습니다.`;
      } else {
        const [currentSnapshot, currentHead] = await Promise.all([
          snapshotWorkspace(snapshot.sessionState.cwd),
          workspaceHeadSha(snapshot.sessionState.cwd),
        ]);
        const sameHead = Boolean(currentHead && currentHead === workflowState.beforeHeadSha);
        if (!sameHead || !sameSnapshot(currentSnapshot, workflowState.beforeSnapshot)) {
          recoveryReason = '에이전트 실행 중 워크스페이스가 바뀌어 재실행하면 결과가 중복될 수 있습니다.';
        }
      }
    }
  } else if (!recoveryReason && workflowState.activeAction === 'delivery') {
    if (!snapshot.sessionState.deliveryContext) {
      recoveryReason = '중단된 PR 전달의 worktree 정보가 체크포인트에 없습니다.';
    } else if (!['commit', 'push', 'pull-request'].includes(workflowState.activeStep ?? '')) {
      recoveryReason = '문서 점검 중 중단되어 쓰기 작업의 완료 여부를 확인할 수 없습니다. worktree를 검토한 뒤 수동 복구가 필요합니다.';
    } else {
      deliveryRecoveryStage = workflowState.activeStep;
    }
  } else if (!recoveryReason && workflowState.activeAction) {
    recoveryReason = `중단된 내부 작업(${workflowState.activeAction})은 안전한 재생을 지원하지 않습니다.`;
  } else if (!recoveryReason) {
    const [currentSnapshot, currentHead] = await Promise.all([
      snapshotWorkspace(snapshot.sessionState.cwd),
      workspaceHeadSha(snapshot.sessionState.cwd),
    ]);
    if (!currentHead || currentHead !== snapshot['baseHeadSha'] || !sameSnapshot(currentSnapshot, snapshot['baseSnapshot'] as Record<string, string> | undefined)) {
      recoveryReason = '체크포인트 이후 워크스페이스가 바뀌었습니다.';
    }
  }

  if (recoveryReason) {
    const sessionState = snapshot['sessionState'] as ClarificationState | undefined;
    const workPath = typeof sessionState?.cwd === 'string' ? sessionState.cwd : '(경로를 확인할 수 없음)';
    const output = [
      '[workflow_recovery_required] 자동 재개를 안전하게 확인하지 못했습니다.',
      `원인: ${recoveryReason}`,
      `작업 경로: ${workPath}`,
      '파일은 되돌리지 않았습니다. 작업 경로의 변경 사항을 확인한 뒤 새 실행 또는 수동 복구를 진행하세요.',
    ].join('\n');
    try {
      finishCheckpoint(candidate.workflowRunId, runtime, 'RECOVERY_REQUIRED', {
        status: 'FAILED', output, durationMs: rootRunDuration(candidate.workflowRunId),
        errorType: 'workflow_recovery_required', stopReason: 'server_restart',
      }, { recoveryReason, finalResult: { verdict: 'RECOVERY_REQUIRED' } });
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('lease lost'))) throw err;
      return false;
    }
    finishRunEvents(candidate.workflowRunId, 'FAILED');
    await notifyOpenClawSpec({
      runId: candidate.workflowRunId,
      project: sessionState?.project,
      verdict: 'RECOVERY_REQUIRED',
      durationMs: rootRunDuration(candidate.workflowRunId),
      reason: recoveryReason,
    });
    return true;
  }

  if (deliveryRecoveryStage) {
    await finishPullRequestDelivery(candidate.workflowRunId, runtime, deliveryRecoveryStage);
    return true;
  }

  const storedOpts = snapshot.options;
  const opts: SpecSessionOptions = {
    ...storedOpts,
    steps: restoreSteps(storedOpts.steps),
    triggerSource: 'dashboard',
  };
  const controller = new AbortController();
  const unregister = registerRunCancellation(candidate.workflowRunId, controller);
  const heartbeat = setInterval(() => {
    if (!heartbeatWorkflowCheckpoint(candidate.workflowRunId, leaseOwner, runtime.revision)) {
      controller.abort(new Error('workflow checkpoint lease lost'));
    }
  }, 20_000);
  heartbeat.unref();
  const state = snapshot.sessionState;
  const input = snapshot.specInput;
  void finalize(candidate.workflowRunId, state, opts, input, undefined, controller.signal, runtime, recoveredResult)
    .finally(() => {
      clearInterval(heartbeat);
      unregister();
    });
  return true;
}

async function finalize(
  runId: string,
  state: ClarificationState,
  opts: SpecSessionOptions,
  input: string,
  resume: { startStep: Step } | undefined,
  signal: AbortSignal,
  checkpointRuntime?: CheckpointRuntime,
  recoveredResult?: RunResult,
): Promise<void> {
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
      projectConfigDir: state.sourceCwd ?? state.cwd,
      deliveryContext: state.deliveryContext,
      startStep: resume?.startStep,
      initialPlanOutput: state.planOutput,
      signal,
      ...(checkpointRuntime ? {
        checkpoint: {
          initialState: checkpointRuntime.workflowState,
          recoveredResult,
          onState: (workflowState: PersistedSpecCheckpointState) => persistCheckpointState(checkpointRuntime, workflowState),
        },
      } : {}),
      ...(checkpointRuntime && state.deliveryContext ? {
        onDeliveryState: (stage: string, deliveryState: PullRequestDeliveryState) => persistDeliveryState(checkpointRuntime, stage, deliveryState),
      } : {}),
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
      const output = `${workflowOutput(result)}\n\n${JSON.stringify(result.clarification, null, 2)}`;
      if (checkpointRuntime) {
        finishCheckpoint(runId, checkpointRuntime, 'WAITING_USER', {
          status: 'DONE', output, durationMs: result.totalDurationMs,
        }, { sessionState: { ...merged, rounds, planOutput }, finalResult: { verdict: result.verdict } });
      } else {
        updateRun(runId, { output, status: 'DONE', durationMs: result.totalDurationMs });
      }
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
    let autoMergeEvidence: AutoMergeWorkflowEvidence | undefined;
    let autoMergeDryRun: AutoMergeDryRunResult | undefined;
    if (checkpointRuntime && state.deliveryContext && result.verdict === 'SHIP' && !result.failure) {
      let projectConfig: ReturnType<typeof loadProjectConfig>;
      try { projectConfig = loadProjectConfig(state.sourceCwd ?? state.cwd); } catch { projectConfig = undefined; }
      autoMergeEvidence = await autoMergeEvidenceForResult(runId, result, projectConfig);
      if (result.delivery?.status === 'DELIVERED') {
        autoMergeDryRun = await runAutoMergeDryRun(runId, checkpointRuntime.snapshot, result.delivery, autoMergeEvidence);
      }
    }
    const deliveryOutput = result.delivery?.status === 'DELIVERED'
      ? `\n\nPR: ${result.delivery.prUrl}`
      : result.delivery?.status === 'DELIVERY_PENDING'
        ? `\n\n[DELIVERY: PENDING]\n${result.delivery.reason ?? 'PR 전달을 마치지 못했습니다.'}`
        : result.delivery?.status === 'NO_CHANGES'
          ? '\n\n[DELIVERY: NO-CHANGES]'
          : '';
    const output = `${workflowOutput(result)}${deliveryOutput}`;
    const errorType = result.verdict === 'CANCELLED' ? 'user_cancelled' : result.failure ? 'workflow_failure' : undefined;
    const stopReason = result.verdict === 'CANCELLED' ? 'user_cancelled' : result.failure?.step;
    if (checkpointRuntime && state.deliveryContext && result.delivery &&
      ['DELIVERY_PENDING', 'DELIVERED', 'NO_CHANGES'].includes(result.delivery.status)) {
      persistDeliveryState(checkpointRuntime, result.delivery.stage ?? 'pull-request', result.delivery);
    }
    if (checkpointRuntime) {
      const checkpointState: WorkflowCheckpointState = result.verdict === 'CANCELLED'
        ? 'CANCELLED'
        : result.delivery?.status === 'DELIVERY_PENDING' ? 'DELIVERY_PENDING'
          : status === 'DONE' ? 'SUCCEEDED' : 'FAILED';
      finishCheckpoint(runId, checkpointRuntime, checkpointState, {
        output, status, durationMs: result.totalDurationMs, errorType, stopReason,
      }, {
        sessionState: { ...merged, planOutput },
        ...(autoMergeEvidence ? { autoMergeEvidence } : {}),
        ...(autoMergeDryRun ? { autoMergeDryRun } : {}),
        finalResult: {
          verdict: result.verdict,
          failure: result.failure,
          delivery: result.delivery,
          ...(autoMergeEvidence ? { autoMergeEvidence } : {}),
          ...(autoMergeDryRun ? { autoMergeDryRun } : {}),
        },
      });
    } else {
      updateRun(runId, {
        output, status, durationMs: result.totalDurationMs,
        ...(errorType ? { errorType, stopReason } : {}),
      });
    }
    finishRunEvents(runId, result.verdict === 'CANCELLED' ? 'CANCELLED' : status);
    await notifyOpenClawSpec({
      runId,
      project: opts.project,
      verdict: result.delivery?.status === 'DELIVERY_PENDING' ? 'DELIVERY_PENDING' : result.verdict ?? status,
      durationMs: result.totalDurationMs,
      reason: result.failure?.reason ?? result.delivery?.reason,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (checkpointRuntime) {
      try {
        finishCheckpoint(runId, checkpointRuntime, 'FAILED', {
          output: `ERROR: ${message}`,
          status: 'FAILED',
          durationMs: Date.now() - wallStart,
          errorType: 'workflow_failure',
          stopReason: 'exception',
        }, { finalResult: { verdict: 'FAILED', failure: { step: 'workflow', status: 'FAILED', cause: 'agent_stopped', reason: message, routeAvailable: false } } });
      } catch (finishError) {
        // Lease가 다른 worker에 넘어간 경우 오래된 worker는 run 상태를 덮어쓰지 않는다.
        if (finishError instanceof Error && finishError.message.includes('lease lost')) return;
        throw finishError;
      }
    } else {
      updateRun(runId, {
        output: `ERROR: ${message}`,
        status: 'FAILED',
        durationMs: Date.now() - wallStart,
      });
    }
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

function deliveryDescription(snapshot: SpecCheckpointSnapshot): PullRequestDescription {
  const state = snapshot.sessionState;
  const projectConfig = loadProjectConfig(state.sourceCwd ?? state.cwd);
  const summary = snapshot.workflowState.runtimeEvidenceSummary.split(/\r?\n/)[0] || 'Deterministic checks passed.';
  return {
    requestSummary: state.spec,
    verifyCommand: projectConfig?.verify?.command,
    verifyConfigured: Boolean(projectConfig?.verify),
    verifyDurationMs: snapshot.workflowState.results[VERIFY_AGENT_NAME]?.durationMs,
    verifySummary: summary,
    reviewSummary: 'Review verdict: SHIP. See workflow evidence for details.',
  };
}

async function autoMergeEvidenceForResult(
  runId: string,
  result: SpecResult,
  projectConfig: ReturnType<typeof loadProjectConfig>,
): Promise<AutoMergeWorkflowEvidence> {
  const children = getRunsByWorkflowId(runId);
  const verificationRuns = children.filter(row => row.agent_name === VERIFY_AGENT_NAME);
  const reviewRuns = children.filter(row => row.agent_name === 'review' || row.agent_name.startsWith('review-'));
  const evidenceFile = await readWorkflowEvidence(runId).catch(() => undefined);
  const deterministicConfigured = Boolean(projectConfig?.verify || projectConfig?.runtime);
  const deterministicPassed = deterministicConfigured && result.steps[VERIFY_AGENT_NAME]?.status === 'DONE' &&
    verificationRuns.some(row => row.status === 'DONE');
  const hasReviewRun = reviewRuns.some(row => row.status === 'DONE') ||
    result.team?.tasks.some(task => task.agent === 'review' && task.status === 'DONE') === true;
  const reviewPassed = result.verdict === 'SHIP' && !result.failure && hasReviewRun;
  const evidenceStored = deterministicPassed && reviewPassed && (
    verificationRuns.some(row => Boolean(row.output?.trim())) && reviewRuns.some(row => Boolean(row.output?.trim())) ||
    (evidenceFile?.records.some(record => record.status === 'PASS') ?? false)
  );
  return { deterministicConfigured, deterministicPassed, reviewPassed, evidenceStored };
}

async function runAutoMergeDryRun(
  runId: string,
  snapshot: SpecCheckpointSnapshot,
  delivery: PullRequestDeliveryState,
  evidence: AutoMergeWorkflowEvidence,
): Promise<AutoMergeDryRunResult> {
  const context = snapshot.sessionState.deliveryContext;
  if (!context) throw new Error('Auto-merge dry-run requires a saved PR delivery context.');
  context.state = delivery;
  const projectDir = snapshot.sessionState.sourceCwd ?? snapshot.sessionState.cwd;
  let projectConfig: ReturnType<typeof loadProjectConfig>;
  try {
    projectConfig = loadProjectConfig(projectDir);
  } catch {
    projectConfig = undefined;
  }
  const projectConfigFingerprint = createHash('sha256').update(JSON.stringify(projectConfig ?? null)).digest('hex');
  let result: AutoMergeDryRunResult;
  try {
    result = evaluateAutoMergeDryRun({
      context,
      projectConfig,
      startingPolicyFingerprint: snapshot.autoMergePolicyFingerprint ?? '',
      models: modelConfig.getAgentModels(),
      runtimeModelSettings: {
        effort: modelConfig.getEffort(),
        fallbackModel: modelConfig.getFallbackModel(),
      },
      evidence,
      autoMergeEnabledAtStart: snapshot.autoMergeEnabledAtStart === true,
      projectConfigUnchanged: projectConfigFingerprint === snapshot.configFingerprint,
    });
  } catch (err) {
    result = deniedAutoMergeDryRun(
      `Auto-merge dry-run failed closed: ${err instanceof Error ? err.message : String(err)}`,
      snapshot.autoMergePolicyFingerprint,
    );
  }

  if (delivery.prNumber && delivery.commitSha) {
    try {
      recordAutoMergeDryRun({
        workflowRunId: runId,
        repository: context.repository,
        prNumber: delivery.prNumber,
        headSha: delivery.commitSha,
        baseSha: context.baseSha,
        baseBranch: context.baseBranch,
        category: result.category,
        policyFingerprint: result.policyFingerprint,
        evalPassCount: result.eval.passedCount,
        evalDistinctCaseCount: result.eval.distinctCaseCount,
        livePassCount: result.live.passedCount,
        eligible: result.eligible,
        reasons: result.reasons,
        checkedAt: result.checkedAt,
      });
    } catch {
      // 자동 머지 dry-run 기록 실패는 이미 전달된 PR의 상태를 바꾸지 않는다.
    }
  }
  emitRunEvent(runId, {
    type: 'tool_result',
    ts: result.checkedAt,
    data: `auto_merge_dry_run:${result.eligible ? 'eligible' : 'denied'} category=${result.category}; ${result.reasons.join(' ')}`.slice(0, 2000),
  });
  return result;
}

function deliveryOutput(base: string, state: PullRequestDeliveryState): string {
  const cleanBase = base
    .replace(/\n\n\[DELIVERY: PENDING\][\s\S]*$/, '')
    .replace(/\n\n\[DELIVERY: NO-CHANGES\]$/, '')
    .replace(/\n\nPR: https?:\/\/\S+$/, '');
  if (state.status === 'DELIVERED') return `${cleanBase}\n\nPR: ${state.prUrl}`;
  if (state.status === 'NO_CHANGES') return `${cleanBase}\n\n[DELIVERY: NO-CHANGES]`;
  return `${cleanBase}\n\n[DELIVERY: PENDING]\n${state.reason ?? 'PR 전달을 마치지 못했습니다.'}`;
}

async function finishPullRequestDelivery(
  runId: string,
  runtime: CheckpointRuntime,
  stage: string,
  signal?: AbortSignal,
): Promise<void> {
  const context = runtime.snapshot.sessionState.deliveryContext;
  if (!context) throw new Error('PR delivery checkpoint has no saved worktree context.');
  if (runtime.snapshot.deliveryState && typeof runtime.snapshot.deliveryState === 'object') {
    context.state = runtime.snapshot.deliveryState as PullRequestDeliveryState;
  }
  let state: PullRequestDeliveryState = {
    status: 'READY',
    stage: stage === 'docs-audit' ? 'docs-audit' : undefined,
  };
  try {
    if (stage === 'docs-audit' || stage === 'post-success') {
      persistDeliveryState(runtime, 'docs-audit', { status: 'READY', stage: 'docs-audit' });
      const audit = await commitSuccessfulSpec({
        specContent: runtime.snapshot.sessionState.spec,
        clarifiedSpec: runtime.workflowState.clarifiedSpec,
        planOutput: runtime.workflowState.planOutput,
        commit: false,
        runOpts: {
          cwd: context.worktreeDir,
          triggerSource: 'background',
          triggerDetail: 'pr-delivery-retry',
          signal,
        },
      });
      if (audit.failure) {
        state = { status: 'DELIVERY_PENDING', stage: 'docs-audit', reason: audit.failure.reason };
      }
    }
    if (state.status !== 'DELIVERY_PENDING') {
      state = await completePullRequestDelivery(context, deliveryDescription(runtime.snapshot), async (nextStage, progress) => {
        persistDeliveryState(runtime, nextStage, progress);
      });
    }
  } catch (err) {
    state = {
      status: 'DELIVERY_PENDING',
      stage: context.state?.stage ?? 'commit',
      commitSha: context.state?.commitSha,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  context.state = state;
  const autoMergeEvidence = runtime.snapshot.autoMergeEvidence ?? runtime.snapshot.finalResult?.autoMergeEvidence;
  const autoMergeDryRun = state.status === 'DELIVERED' && autoMergeEvidence
    ? await runAutoMergeDryRun(runId, runtime.snapshot, state, autoMergeEvidence)
    : runtime.snapshot.autoMergeDryRun;
  runtime.snapshot = {
    ...runtimeSnapshot(runtime),
    sessionState: { ...runtime.snapshot.sessionState, deliveryContext: context },
    deliveryContext: context,
    deliveryState: state,
    ...(autoMergeEvidence ? { autoMergeEvidence } : {}),
    ...(autoMergeDryRun ? { autoMergeDryRun } : {}),
    activeAction: undefined,
    activeStep: undefined,
    activeRunId: undefined,
    activeInput: undefined,
    actionStartedAt: undefined,
  };
  runtime.workflowState = {
    ...runtime.workflowState,
    activeAction: undefined,
    activeStep: undefined,
    activeRunId: undefined,
    activeInput: undefined,
    actionStartedAt: undefined,
  };
  runtime.snapshot.workflowState = runtime.workflowState;
  const prior = getRun(runId)?.output ?? '';
  const output = deliveryOutput(prior, state);
  const nextCheckpointState: WorkflowCheckpointState = state.status === 'DELIVERY_PENDING' ? 'DELIVERY_PENDING' : 'SUCCEEDED';
  finishCheckpoint(runId, runtime, nextCheckpointState, {
    status: 'DONE', output, durationMs: rootRunDuration(runId),
  }, {
    sessionState: runtime.snapshot.sessionState,
    deliveryContext: context,
    deliveryState: state,
    ...(autoMergeEvidence ? { autoMergeEvidence } : {}),
    ...(autoMergeDryRun ? { autoMergeDryRun } : {}),
    finalResult: {
      ...(runtime.snapshot.finalResult ?? {}),
      verdict: 'SHIP',
      delivery: state,
      ...(autoMergeEvidence ? { autoMergeEvidence } : {}),
      ...(autoMergeDryRun ? { autoMergeDryRun } : {}),
    },
  });
  finishRunEvents(runId, 'DONE');
  await notifyOpenClawSpec({
    runId,
    project: runtime.snapshot.sessionState.project,
    verdict: state.status === 'DELIVERY_PENDING' ? 'DELIVERY_PENDING' : 'SHIP',
    durationMs: rootRunDuration(runId),
    reason: state.reason,
  });
}

/** DELIVERY_PENDING worktree의 문서 점검/commit/push/PR 단계를 재시도한다. */
export function retryPullRequestDelivery(runId: string): DeliveryRetryHandle {
  const current = getWorkflowCheckpoint(runId);
  if (!current || current.state !== 'DELIVERY_PENDING') throw new Error('Run has no pending PR delivery.');
  const snapshot = current.snapshot as SpecCheckpointSnapshot;
  if (snapshot.kind !== 'dashboard-spec-session' || !snapshot.sessionState.deliveryContext) {
    throw new Error('Run has no resumable PR delivery context.');
  }
  const config = loadProjectConfig(snapshot.sessionState.sourceCwd ?? snapshot.sessionState.cwd);
  const fingerprint = createHash('sha256').update(JSON.stringify(config ?? null)).digest('hex');
  if (config?.delivery?.mode !== 'pull-request' || fingerprint !== snapshot.configFingerprint) {
    throw new Error('PR delivery configuration changed after the run. Start a new workflow after reviewing the saved worktree.');
  }
  validatePullRequestDeliveryContext(snapshot.sessionState.deliveryContext, process.env);
  const owner = createCheckpointLeaseOwner();
  const claimed = claimWorkflowDeliveryRetry(runId, owner, current.revision);
  if (!claimed) throw new Error('PR delivery is already being retried or the checkpoint changed.');
  const runtime = createCheckpointRuntime(claimed, owner, claimed.snapshot as SpecCheckpointSnapshot);
  const controller = new AbortController();
  const unregister = registerRunCancellation(runId, controller);
  const heartbeat = setInterval(() => {
    if (!heartbeatWorkflowCheckpoint(runId, owner, runtime.revision)) controller.abort(new Error('workflow checkpoint lease lost'));
  }, 20_000);
  heartbeat.unref();
  const stage = String(runtime.snapshot.deliveryState && typeof runtime.snapshot.deliveryState === 'object'
    ? (runtime.snapshot.deliveryState as Record<string, unknown>)['stage'] ?? 'docs-audit'
    : 'docs-audit');
  const done = finishPullRequestDelivery(runId, runtime, stage, controller.signal)
    .catch((err) => {
      console.error(`PR delivery retry failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      clearInterval(heartbeat);
      unregister();
    });
  return { done };
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
