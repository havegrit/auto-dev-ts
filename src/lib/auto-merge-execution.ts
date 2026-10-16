import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { PullRequestDeliveryContext } from './pr-delivery.js';
import type { ProjectConfig } from './project-config.js';
import { appConfig } from './app-config.js';
import { loadProjectConfig } from './project-config.js';
import { modelConfig } from './model-config.js';
import { evaluateAutoMergeDryRun, type AutoMergeDryRunResult, type AutoMergeWorkflowEvidence } from './auto-merge.js';
import {
  claimAutoMergeRequest,
  finishAutoMergeRequestClaim,
  getAutoMergeRequestClaim,
  recordAutoMergeAction,
} from '../store/auto-merge.js';
import type { AutoMergeActionRecord, AutoMergeActionStatus, AutoMergeRequestClaim } from '../store/auto-merge.js';

export interface AutoMergeActionResult {
  status: AutoMergeActionStatus;
  reason: string;
  recordedAt: string;
}

export interface AutoMergeExecutionInput {
  context: PullRequestDeliveryContext;
  projectConfig: ProjectConfig | undefined;
  configFingerprintAtStart: string;
  startingPolicyFingerprint: string;
  models: Record<string, string>;
  runtimeModelSettings?: { effort?: string; fallbackModel?: string };
  evidence: AutoMergeWorkflowEvidence;
  autoMergeEnabledAtStart: boolean;
  autoMergeRequestEnabledAtStart: boolean;
  projectConfigUnchanged: boolean;
  dryRun: AutoMergeDryRunResult;
}

export interface AutoMergeExecutionDependencies {
  env: NodeJS.ProcessEnv;
  enabled(): boolean;
  gh(args: string[], cwd: string): string;
  evaluate(input: Omit<AutoMergeExecutionInput, 'dryRun' | 'autoMergeRequestEnabledAtStart'>): AutoMergeDryRunResult;
  getClaim(repository: string, prNumber: number, headSha: string): AutoMergeRequestClaim | undefined;
  claim(record: Pick<AutoMergeActionRecord, 'repository' | 'prNumber' | 'headSha' | 'workflowRunId'>): boolean;
  finishClaim(repository: string, prNumber: number, headSha: string, state: 'requested' | 'failed'): void;
  record(record: AutoMergeActionRecord): void;
  now(): Date;
}

const defaultDependencies: AutoMergeExecutionDependencies = {
  env: process.env,
  enabled: () => appConfig.get().autoMergeEnabled === true,
  gh(args, cwd) {
    return execFileSync('gh', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    }).trim();
  },
  evaluate(input) {
    const projectConfig = loadProjectConfig(input.context.sourceDir);
    const configFingerprint = createHash('sha256').update(JSON.stringify(projectConfig ?? null)).digest('hex');
    return evaluateAutoMergeDryRun({
      ...input,
      projectConfig,
      models: modelConfig.getAgentModels(),
      runtimeModelSettings: {
        effort: modelConfig.getEffort(),
        fallbackModel: modelConfig.getFallbackModel(),
      },
      projectConfigUnchanged: input.projectConfigUnchanged && configFingerprint === input.configFingerprintAtStart,
    });
  },
  getClaim: getAutoMergeRequestClaim,
  claim: claimAutoMergeRequest,
  finishClaim: finishAutoMergeRequestClaim,
  record: recordAutoMergeAction,
  now: () => new Date(),
};

function parseObject(value: string, label: string): Record<string, unknown> {
  try {
    const result: unknown = JSON.parse(value);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('expected an object');
    return result as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${label} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function allowedRepositories(env: NodeJS.ProcessEnv): { repositories: Set<string>; invalid: boolean } {
  const raw = env.AUTO_DEV_AUTO_MERGE_REPOSITORIES ?? '';
  const values = raw.split(',').map(value => value.trim()).filter(Boolean);
  const valid = values.every(value => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value));
  return { repositories: new Set(values.map(value => value.toLowerCase())), invalid: !valid };
}

function actionRecord(
  input: AutoMergeExecutionInput,
  status: AutoMergeActionStatus,
  reason: string,
): AutoMergeActionRecord | undefined {
  const delivery = input.context.state;
  if (!delivery?.prNumber || !delivery.commitSha) return undefined;
  return {
    workflowRunId: input.context.workflowRunId,
    repository: input.context.repository,
    prNumber: delivery.prNumber,
    headSha: delivery.commitSha,
    baseSha: input.context.baseSha,
    category: input.dryRun.category,
    policyFingerprint: input.dryRun.policyFingerprint,
    status,
    actor: 'auto-dev',
    reason,
  };
}

function finish(
  input: AutoMergeExecutionInput,
  dependencies: AutoMergeExecutionDependencies,
  status: AutoMergeActionStatus,
  reason: string,
): AutoMergeActionResult {
  const recordedAt = dependencies.now().toISOString();
  const record = actionRecord(input, status, reason);
  let finalReason = reason;
  if (record) {
    try {
      dependencies.record({ ...record, createdAt: recordedAt });
    } catch (err) {
      finalReason += ` Audit event persistence failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { status, reason: finalReason, recordedAt };
}

function verifyActionOptIns(input: AutoMergeExecutionInput, dependencies: AutoMergeExecutionDependencies): string | undefined {
  if (!input.autoMergeRequestEnabledAtStart || input.projectConfig?.delivery?.autoMerge?.requestMerge !== true) {
    return 'Project did not explicitly request auto-merge at workflow start.';
  }
  if (!input.autoMergeEnabledAtStart || input.projectConfig.delivery.autoMerge.enabled !== true) {
    return 'Project auto-merge eligibility was not enabled at workflow start.';
  }
  if (!input.projectConfigUnchanged) return 'Project configuration changed during the workflow.';
  if (dependencies.env.AUTO_DEV_AUTO_MERGE_ENABLED !== 'true') return 'Server auto-merge capability is disabled by environment.';
  if (!dependencies.enabled()) return 'Global auto-merge kill switch is off.';
  const allowlist = allowedRepositories(dependencies.env);
  if (allowlist.invalid) return 'Server auto-merge repository allowlist has an invalid entry.';
  if (!allowlist.repositories.has(input.context.repository.toLowerCase())) {
    return 'Repository is not present in the server auto-merge allowlist.';
  }
  return undefined;
}

/** 모든 opt-in과 정책을 다시 확인한 뒤 PR 한 건에 한 번만 GitHub auto-merge를 요청한다. */
export function requestQualifiedAutoMerge(
  input: AutoMergeExecutionInput,
  dependencies: AutoMergeExecutionDependencies = defaultDependencies,
): AutoMergeActionResult {
  const optInFailure = verifyActionOptIns(input, dependencies);
  if (optInFailure) return finish(input, dependencies, 'blocked', optInFailure);
  if (!input.dryRun.eligible) return finish(input, dependencies, 'blocked', 'The latest auto-merge dry-run is not eligible.');

  const context = input.context;
  const prNumber = context.state?.prNumber;
  const headSha = context.state?.commitSha;
  if (!prNumber || !headSha) return finish(input, dependencies, 'blocked', 'Verified PR number or head SHA is missing.');

  const existingClaim = dependencies.getClaim(context.repository, prNumber, headSha);
  if (existingClaim) {
    const status = existingClaim.state === 'requested' ? 'already-requested' : 'blocked';
    const reason = existingClaim.state === 'requested'
      ? 'An auto-merge request is already recorded for this PR head.'
      : `A prior auto-merge attempt is ${existingClaim.state}; manual inspection is required before retrying.`;
    return finish(input, dependencies, status, reason);
  }

  let rechecked: AutoMergeDryRunResult;
  try {
    rechecked = dependencies.evaluate({
      context,
      projectConfig: input.projectConfig,
      configFingerprintAtStart: input.configFingerprintAtStart,
      startingPolicyFingerprint: input.startingPolicyFingerprint,
      models: input.models,
      runtimeModelSettings: input.runtimeModelSettings,
      evidence: input.evidence,
      autoMergeEnabledAtStart: input.autoMergeEnabledAtStart,
      projectConfigUnchanged: input.projectConfigUnchanged,
    });
  } catch (err) {
    return finish(input, dependencies, 'blocked', `Fresh policy/GitHub verification failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 2000));
  }
  if (!rechecked.eligible || rechecked.policyFingerprint !== input.dryRun.policyFingerprint ||
    rechecked.headSha !== headSha || rechecked.baseSha !== context.baseSha) {
    return finish(input, dependencies, 'blocked', 'Fresh GitHub and policy checks no longer match the qualified PR head/base.');
  }

  const claimRecord = actionRecord(input, 'requested', 'pending request');
  if (!claimRecord || !dependencies.claim(claimRecord)) {
    return finish(input, dependencies, 'blocked', 'Another workflow has claimed this PR head for auto-merge; inspect its audit record.');
  }

  try {
    const view = parseObject(dependencies.gh([
      'pr', 'view', String(prNumber), '--repo', context.repository,
      '--json', 'state,headRefOid,autoMergeRequest',
    ], context.worktreeDir), 'gh pr view');
    if (view.state !== 'OPEN' || view.headRefOid !== headSha) {
      try { dependencies.finishClaim(context.repository, prNumber, headSha, 'failed'); } catch { /* unresolved claims remain fail-closed */ }
      return finish(input, dependencies, 'blocked', 'PR state or head changed immediately before the merge request.');
    }
    if (view.autoMergeRequest) {
      try { dependencies.finishClaim(context.repository, prNumber, headSha, 'requested'); } catch { /* existing GitHub request still prevents another command */ }
      return finish(input, dependencies, 'already-requested', 'GitHub already has an auto-merge request for this PR.');
    }

    const lastCheckFailure = verifyActionOptIns(input, dependencies);
    if (lastCheckFailure) {
      try { dependencies.finishClaim(context.repository, prNumber, headSha, 'failed'); } catch { /* unresolved claims remain fail-closed */ }
      return finish(input, dependencies, 'blocked', lastCheckFailure);
    }

    const intent = actionRecord(input, 'pending', 'Submitting GitHub auto-merge request.');
    if (!intent) {
      try { dependencies.finishClaim(context.repository, prNumber, headSha, 'failed'); } catch { /* unresolved claims remain fail-closed */ }
      return { status: 'failed', reason: 'Could not build an auditable merge request intent.', recordedAt: dependencies.now().toISOString() };
    }
    try {
      dependencies.record({ ...intent, createdAt: dependencies.now().toISOString() });
    } catch (err) {
      try { dependencies.finishClaim(context.repository, prNumber, headSha, 'failed'); } catch { /* unresolved claims remain fail-closed */ }
      return {
        status: 'failed',
        reason: `Could not persist merge request intent; no GitHub merge request was sent: ${err instanceof Error ? err.message : String(err)}`,
        recordedAt: dependencies.now().toISOString(),
      };
    }

    dependencies.gh([
      'pr', 'merge', String(prNumber), '--repo', context.repository,
      '--match-head-commit', headSha, '--auto',
    ], context.worktreeDir);
    let claimWarning = '';
    try {
      dependencies.finishClaim(context.repository, prNumber, headSha, 'requested');
    } catch (err) {
      claimWarning = ` Request claim update failed and remains fail-closed: ${err instanceof Error ? err.message : String(err)}`;
    }
    return finish(input, dependencies, 'requested', `GitHub accepted the auto-merge request; branch protection remains in force.${claimWarning}`);
  } catch (err) {
    try { dependencies.finishClaim(context.repository, prNumber, headSha, 'failed'); } catch { /* unresolved claims remain fail-closed */ }
    return finish(input, dependencies, 'failed', `GitHub auto-merge request failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 2000));
  }
}
