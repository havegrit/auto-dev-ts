import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { PullRequestDeliveryContext } from './pr-delivery.js';
import type { ProjectConfig } from './project-config.js';
import {
  AUTO_MERGE_EVAL_CASE_MIN,
  AUTO_MERGE_EVAL_STREAK_MIN,
  AUTO_MERGE_LIVE_PR_STREAK_MIN,
  autoMergePolicyFingerprint,
  classifyAutoMergeFiles,
  loadEvalTrustStreak,
  type AutoMergeClassification,
  type AutoMergeRiskCategory,
  type EvalTrustStreak,
} from './auto-merge-policy.js';
import {
  getAutoMergeKnownPullRequests,
  getAutoMergeLiveTrustStreak,
  recordAutoMergeLiveObservation,
  type AutoMergeLiveTrustStreak,
} from '../store/auto-merge.js';

export interface AutoMergeWorkflowEvidence {
  deterministicConfigured: boolean;
  deterministicPassed: boolean;
  reviewPassed: boolean;
  evidenceStored: boolean;
}

export interface AutoMergeDryRunResult {
  mode: 'dry-run';
  eligible: boolean;
  category: AutoMergeClassification;
  policyFingerprint: string;
  headSha?: string;
  baseSha?: string;
  eval: Pick<EvalTrustStreak, 'passedCount' | 'distinctCaseCount' | 'requiredCount' | 'requiredDistinctCases' | 'qualifies'>;
  live: Pick<AutoMergeLiveTrustStreak, 'passedCount' | 'requiredCount' | 'qualifies'>;
  reasons: string[];
  checkedAt: string;
}

export function deniedAutoMergeDryRun(reason: string, policyFingerprint = 'unavailable', checkedAt = new Date().toISOString()): AutoMergeDryRunResult {
  return {
    mode: 'dry-run',
    eligible: false,
    category: 'ineligible',
    policyFingerprint,
    eval: {
      passedCount: 0,
      distinctCaseCount: 0,
      requiredCount: AUTO_MERGE_EVAL_STREAK_MIN,
      requiredDistinctCases: AUTO_MERGE_EVAL_CASE_MIN,
      qualifies: false,
    },
    live: {
      passedCount: 0,
      requiredCount: AUTO_MERGE_LIVE_PR_STREAK_MIN,
      qualifies: false,
    },
    reasons: [reason],
    checkedAt,
  };
}

interface PullRequestView {
  state?: string;
  isDraft?: boolean;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  baseRefOid?: string;
  mergeStateStatus?: string;
  author?: { login?: string };
  reviews?: Array<{ state?: string; author?: { login?: string }; commit?: { oid?: string } }>;
  statusCheckRollup?: Array<{ name?: string; status?: string; conclusion?: string }>;
}

interface BranchProtection {
  required_status_checks?: {
    contexts?: string[];
    checks?: Array<{ context?: string }>;
  };
  required_pull_request_reviews?: {
    required_approving_review_count?: number;
  };
  commit?: { sha?: string };
}

interface AutoMergeDependencies {
  gh(args: string[], cwd: string): string;
  evalStreak(category: AutoMergeRiskCategory, fingerprint: string): EvalTrustStreak;
  liveStreak(context: PullRequestDeliveryContext, category: AutoMergeRiskCategory, fingerprint: string): AutoMergeLiveTrustStreak;
  now(): Date;
}

interface MergedPullRequestSummary {
  number?: number;
  headRefName?: string;
  headRefOid?: string;
  mergedAt?: string;
  mergedBy?: { login?: string };
}

interface LivePullRequestView extends MergedPullRequestSummary {
  state?: string;
  baseRefName?: string;
  author?: { login?: string };
  reviews?: Array<{ state?: string; author?: { login?: string }; commit?: { oid?: string } }>;
  labels?: Array<{ name?: string }>;
}

interface PullRequestIssueEvent {
  event?: string;
  created_at?: string;
  actor?: { login?: string };
  label?: { name?: string };
}

const defaultDependencies: AutoMergeDependencies = {
  gh(args, cwd) {
    return execFileSync('gh', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    }).trim();
  },
  evalStreak(category, fingerprint) {
    return loadEvalTrustStreak(resolve('data/evals'), category, fingerprint);
  },
  liveStreak(context, category, fingerprint) {
    return synchronizeAutoMergeLiveHistory(context, category, fingerprint, this.gh, this.now());
  },
  now: () => new Date(),
};

function parseObject<T>(value: string, label: string): T {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object');
    return parsed as T;
  } catch (err) {
    throw new Error(`${label} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseArray<T>(value: string, label: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('expected an array');
    return parsed as T[];
  } catch (err) {
    throw new Error(`${label} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function humanReviewer(view: LivePullRequestView, headSha: string): string | undefined {
  const author = view.author?.login?.toLowerCase();
  return view.reviews?.find(review => {
    const login = review.author?.login?.toLowerCase();
    return review.state === 'APPROVED' && review.commit?.oid === headSha && Boolean(login) && login !== author && !login!.endsWith('[bot]');
  })?.author?.login;
}

/** 사람이 14일 뒤에 붙인 안정 label만 live 성공으로 저장한다. */
export function synchronizeAutoMergeLiveHistory(
  context: PullRequestDeliveryContext,
  category: AutoMergeRiskCategory,
  fingerprint: string,
  runGh: AutoMergeDependencies['gh'],
  now: Date,
): AutoMergeLiveTrustStreak {
  const candidates = getAutoMergeKnownPullRequests(context.repository, context.baseBranch)
    .filter(candidate => candidate.category === category);
  const merged = parseArray<MergedPullRequestSummary>(runGh([
    'pr', 'list', '--repo', context.repository, '--base', context.baseBranch, '--state', 'merged', '--limit', '1000',
    '--json', 'number,headRefName,headRefOid,mergedAt,mergedBy',
  ], context.worktreeDir), 'gh pr list');
  if (merged.length >= 1000) throw new Error('GitHub returned 1000 merged PRs; live history is truncated.');
  const mergedById = new Map(merged.map(pr => [pr.number, pr]));
  const failureLabels: Record<string, 'reverted' | 'hotfix' | 'rework'> = {
    'auto-dev/merge-reverted': 'reverted',
    'auto-dev/merge-hotfix': 'hotfix',
    'auto-dev/merge-rework': 'rework',
  };

  for (const candidate of candidates) {
    const summary = mergedById.get(candidate.prNumber);
    if (!summary || !summary.mergedAt) continue;
    const recordUnverified = (evidenceSource: string, headSha = candidate.headSha): void => {
      recordAutoMergeLiveObservation({
        repository: context.repository,
        baseBranch: context.baseBranch,
        prNumber: candidate.prNumber,
        headSha,
        category,
        policyFingerprint: candidate.policyFingerprint,
        outcome: 'unknown',
        mergedBy: summary.mergedBy?.login ?? 'unverified',
        approvedBy: 'unverified',
        evidenceSource,
        mergedAt: summary.mergedAt!,
        recordedAt: now.toISOString(),
      }, undefined, now);
    };
    if (summary.headRefName?.startsWith('autodev/') !== true) {
      recordUnverified('github-observation:auto-dev-branch-changed');
      continue;
    }
    if (summary.headRefOid !== candidate.headSha) {
      recordUnverified('github-observation:verified-head-changed', summary.headRefOid ?? candidate.headSha);
      continue;
    }
    const merger = summary.mergedBy?.login;
    if (!merger || merger.toLowerCase().endsWith('[bot]')) {
      recordUnverified('github-observation:human-merge-not-confirmed');
      continue;
    }
    const view = parseObject<LivePullRequestView>(runGh([
      'pr', 'view', String(candidate.prNumber), '--repo', context.repository,
      '--json', 'state,headRefName,headRefOid,baseRefName,mergedAt,mergedBy,author,reviews,labels',
    ], context.worktreeDir), `gh pr view ${candidate.prNumber}`);
    if (view.state !== 'MERGED' || view.headRefOid !== candidate.headSha || view.baseRefName !== context.baseBranch ||
      view.mergedBy?.login !== merger) {
      recordUnverified('github-observation:merged-PR-metadata-changed');
      continue;
    }

    const events = parseArray<PullRequestIssueEvent>(runGh([
      'api', `repos/${context.repository}/issues/${candidate.prNumber}/events?per_page=100`,
    ], context.worktreeDir), `GitHub PR ${candidate.prNumber} label events`);
    const mergedAt = Date.parse(view.mergedAt ?? summary.mergedAt);
    const stabilityDeadline = mergedAt + 14 * 24 * 60 * 60 * 1000;
    let outcome: 'stable' | 'reverted' | 'hotfix' | 'rework' | 'unknown' = 'unknown';
    let evidenceSource = events.length >= 100 ? 'github-observation:label-events-truncated' : 'github-observation:stability-unconfirmed';
    const failureEvent = events.find(event => event.event === 'labeled' && event.label?.name && failureLabels[event.label.name]);
    let stableEvent: PullRequestIssueEvent | undefined;
    if (failureEvent?.label?.name) {
      outcome = failureLabels[failureEvent.label.name];
      evidenceSource = `github-label:${failureEvent.label.name}`;
    } else {
      const stableIsCurrent = (view.labels ?? []).some(label => label.name === 'auto-dev/merge-stable');
      stableEvent = events.find(event => event.event === 'labeled' &&
        event.label?.name === 'auto-dev/merge-stable' && Date.parse(event.created_at ?? '') >= stabilityDeadline &&
        Boolean(event.actor?.login) && !event.actor!.login!.toLowerCase().endsWith('[bot]') &&
        event.actor!.login!.toLowerCase() !== view.author?.login?.toLowerCase());
      const reviewer = humanReviewer(view, candidate.headSha);
      if (events.length < 100 && stableIsCurrent && stableEvent && reviewer &&
        Date.parse(stableEvent.created_at ?? '') <= now.getTime()) {
        outcome = 'stable';
        evidenceSource = `github-label:auto-dev/merge-stable by ${stableEvent.actor!.login}`;
      }
    }

    recordAutoMergeLiveObservation({
      repository: context.repository,
      baseBranch: context.baseBranch,
      prNumber: candidate.prNumber,
      headSha: candidate.headSha,
      category,
      policyFingerprint: candidate.policyFingerprint,
      outcome,
      mergedBy: merger,
      approvedBy: humanReviewer(view, candidate.headSha) ?? 'unverified',
      evidenceSource,
      mergedAt: view.mergedAt ?? summary.mergedAt,
      ...(outcome === 'stable' && stableEvent?.created_at ? { stabilityVerifiedAt: stableEvent.created_at } : {}),
      recordedAt: now.toISOString(),
    }, undefined, now);
  }

  return getAutoMergeLiveTrustStreak(context.repository, context.baseBranch, category, fingerprint, undefined, now);
}

function parseFiles(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some(entry => !entry || typeof entry.filename !== 'string')) {
      throw new Error('expected a JSON array with filenames');
    }
    if (parsed.length >= 100) throw new Error('PR has 100 or more changed files; classification fails closed');
    return parsed.map(entry => (entry as { filename: string }).filename);
  } catch (err) {
    throw new Error(`GitHub PR file list is unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function hasHumanApproval(view: PullRequestView): boolean {
  const author = view.author?.login?.toLowerCase();
  return (view.reviews ?? []).some(review => {
    const reviewer = review.author?.login?.toLowerCase();
    return review.state === 'APPROVED' && review.commit?.oid === view.headRefOid &&
      Boolean(reviewer) && reviewer !== author && !reviewer!.endsWith('[bot]');
  });
}

function requiredChecks(protection: BranchProtection): string[] {
  const statuses = protection.required_status_checks;
  if (!statuses) return [];
  return [...new Set([
    ...(statuses.contexts ?? []),
    ...(statuses.checks ?? []).flatMap(check => check.context ? [check.context] : []),
  ])];
}

function failedRequiredChecks(view: PullRequestView, required: string[]): string[] {
  const rollup = view.statusCheckRollup ?? [];
  return required.filter(context => !rollup.some(check =>
    check.name === context && check.conclusion === 'SUCCESS'));
}

function uniqueReasons(reasons: string[]): string[] {
  return [...new Set(reasons)];
}

/** PR 상태를 읽기만 하고, 자동 머지 가능 여부를 dry-run으로 기록할 결과를 만든다. */
export function evaluateAutoMergeDryRun(
  input: {
    context: PullRequestDeliveryContext;
    projectConfig: ProjectConfig | undefined;
    startingPolicyFingerprint: string;
    models: Record<string, string>;
    runtimeModelSettings?: { effort?: string; fallbackModel?: string };
    evidence: AutoMergeWorkflowEvidence;
    autoMergeEnabledAtStart: boolean;
    projectConfigUnchanged: boolean;
  },
  dependencies: AutoMergeDependencies = defaultDependencies,
): AutoMergeDryRunResult {
  const { context, projectConfig, evidence } = input;
  const checkedAt = dependencies.now().toISOString();
  const currentFingerprint = autoMergePolicyFingerprint(projectConfig, input.models, input.runtimeModelSettings);
  const reasons: string[] = [];
  if (!input.autoMergeEnabledAtStart || projectConfig?.delivery?.autoMerge?.enabled !== true) {
    reasons.push('Project auto-merge dry-run was not explicitly enabled at workflow start.');
  }
  if (!input.projectConfigUnchanged) reasons.push('Project configuration changed during the workflow.');
  if (currentFingerprint !== input.startingPolicyFingerprint) reasons.push('Model, prompt, verification, or classification policy changed during the workflow.');
  if (!evidence.deterministicConfigured) reasons.push('No deterministic verification command or runtime check is configured.');
  if (!evidence.deterministicPassed) reasons.push('Deterministic verification did not pass.');
  if (!evidence.reviewPassed) reasons.push('Review did not produce a successful SHIP verdict.');
  if (!evidence.evidenceStored) reasons.push('Verification evidence is not stored.');

  const prNumber = context.state?.prNumber;
  const expectedHead = context.state?.commitSha;
  let category: AutoMergeClassification = 'ineligible';
  let headSha: string | undefined;
  let baseSha: string | undefined;
  let evalTrust: EvalTrustStreak = {
    passedCount: 0,
    distinctCaseCount: 0,
    requiredCount: AUTO_MERGE_EVAL_STREAK_MIN,
    requiredDistinctCases: AUTO_MERGE_EVAL_CASE_MIN,
    qualifies: false,
    reason: 'Eval trust was not checked.',
  };
  let liveTrust: AutoMergeLiveTrustStreak = {
    passedCount: 0,
    requiredCount: AUTO_MERGE_LIVE_PR_STREAK_MIN,
    qualifies: false,
    reason: 'Live PR trust was not checked.',
  };

  if (input.autoMergeEnabledAtStart && input.projectConfigUnchanged && projectConfig?.delivery?.autoMerge?.enabled === true && prNumber && expectedHead) {
    try {
      const repo = context.repository;
      const view = parseObject<PullRequestView>(dependencies.gh([
        'pr', 'view', String(prNumber), '--repo', repo,
        '--json', 'state,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,mergeStateStatus,author,reviews,statusCheckRollup',
      ], context.worktreeDir), 'gh pr view');
      const encodedBase = encodeURIComponent(context.baseBranch);
      const protection = parseObject<BranchProtection>(dependencies.gh([
        'api', `repos/${repo}/branches/${encodedBase}/protection`,
      ], context.worktreeDir), 'GitHub branch protection lookup');
      const files = parseFiles(dependencies.gh([
        'api', `repos/${repo}/pulls/${prNumber}/files?per_page=100`,
      ], context.worktreeDir));
      headSha = view.headRefOid;
      baseSha = view.baseRefOid ?? protection.commit?.sha;
      category = classifyAutoMergeFiles(files);

      if (view.state !== 'OPEN') reasons.push('PR is not open.');
      if (view.isDraft) reasons.push('Draft PRs cannot qualify.');
      if (view.headRefName !== context.branch) reasons.push('PR head branch does not match the verified run branch.');
      if (!headSha || headSha !== expectedHead) reasons.push('PR head SHA changed after verification.');
      if (view.baseRefName !== context.baseBranch) reasons.push('PR base branch does not match the configured base.');
      if (!baseSha || baseSha !== context.baseSha) reasons.push('PR base SHA changed after verification.');
      if (view.mergeStateStatus !== 'CLEAN') reasons.push(`PR merge state is ${view.mergeStateStatus ?? 'unknown'}, not CLEAN.`);
      if (category === 'ineligible') reasons.push('The actual PR diff is outside the protected low-risk allowlists.');

      const checks = requiredChecks(protection);
      if (checks.length === 0) reasons.push('Base branch has no required status checks.');
      const failedChecks = failedRequiredChecks(view, checks);
      if (failedChecks.length) reasons.push(`Required status checks are not successful: ${failedChecks.join(', ')}.`);
      const requiredApprovals = protection.required_pull_request_reviews?.required_approving_review_count ?? 0;
      if (requiredApprovals < 1) reasons.push('Base branch does not require at least one pull request approval.');
      if (!hasHumanApproval(view)) reasons.push('PR has no approval from a human reviewer other than its author.');

      if (category !== 'ineligible') {
        evalTrust = dependencies.evalStreak(category, currentFingerprint);
        liveTrust = dependencies.liveStreak(context, category, currentFingerprint);
        if (!evalTrust.qualifies) reasons.push(evalTrust.reason);
        if (!liveTrust.qualifies) reasons.push(liveTrust.reason);
      }
    } catch (err) {
      reasons.push(`GitHub state could not be verified: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    if (input.autoMergeEnabledAtStart && projectConfig?.delivery?.autoMerge?.enabled === true && !prNumber) reasons.push('No delivered pull request is available for evaluation.');
    if (input.autoMergeEnabledAtStart && projectConfig?.delivery?.autoMerge?.enabled === true && !expectedHead) reasons.push('Verified PR head SHA is missing.');
  }

  return {
    mode: 'dry-run',
    eligible: reasons.length === 0,
    category,
    policyFingerprint: currentFingerprint,
    ...(headSha ? { headSha } : {}),
    ...(baseSha ? { baseSha } : {}),
    eval: {
      passedCount: evalTrust.passedCount,
      distinctCaseCount: evalTrust.distinctCaseCount,
      requiredCount: evalTrust.requiredCount,
      requiredDistinctCases: evalTrust.requiredDistinctCases,
      qualifies: evalTrust.qualifies,
    },
    live: {
      passedCount: liveTrust.passedCount,
      requiredCount: liveTrust.requiredCount,
      qualifies: liveTrust.qualifies,
    },
    reasons: uniqueReasons(reasons),
    checkedAt,
  };
}
