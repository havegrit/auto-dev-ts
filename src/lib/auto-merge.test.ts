import { describe, expect, it, vi } from 'vitest';
const liveHistoryMocks = vi.hoisted(() => ({
  known: [] as Array<Record<string, unknown>>,
  records: [] as Array<Record<string, unknown>>,
}));
vi.mock('../store/auto-merge.js', () => ({
  getAutoMergeKnownPullRequests: () => liveHistoryMocks.known,
  getAutoMergeLiveTrustStreak: () => ({ passedCount: 0, requiredCount: 10, qualifies: false, reason: 'not enough' }),
  recordAutoMergeLiveObservation: (record: Record<string, unknown>) => liveHistoryMocks.records.push(record),
}));
import { autoMergePolicyFingerprint, type AutoMergeRiskCategory } from './auto-merge-policy.js';
import { evaluateAutoMergeDryRun, synchronizeAutoMergeLiveHistory } from './auto-merge.js';
import type { PullRequestDeliveryContext } from './pr-delivery.js';
import type { ProjectConfig } from './project-config.js';

const projectConfig: ProjectConfig = {
  version: 1,
  verify: { command: 'npm test', timeoutMs: 60_000 },
  delivery: { mode: 'pull-request', autoMerge: { enabled: true, requestMerge: false } },
};
const models = { scaffold: 'model-a', review: 'model-b' };
const expectedFingerprint = autoMergePolicyFingerprint(projectConfig, models);

function context(): PullRequestDeliveryContext {
  return {
    workflowRunId: 'run-12345678',
    sourceDir: '/repo',
    worktreeDir: '/repo/data/worktrees/run-12345678',
    remote: 'origin',
    repository: 'org/project',
    branch: 'autodev/12345678',
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
    publicBaseUrl: 'https://auto-dev.example',
    accessControl: 'authenticated',
    state: { status: 'DELIVERED', prNumber: 42, commitSha: 'b'.repeat(40) },
  };
}

function ghFacts(overrides: Record<string, unknown> = {}) {
  return {
    view: {
      state: 'OPEN',
      isDraft: false,
      headRefName: 'autodev/12345678',
      headRefOid: 'b'.repeat(40),
      baseRefName: 'main',
      baseRefOid: 'a'.repeat(40),
      mergeStateStatus: 'CLEAN',
      author: { login: 'auto-dev[bot]' },
      reviews: [{ state: 'APPROVED', author: { login: 'human-reviewer' }, commit: { oid: 'b'.repeat(40) } }],
      statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }],
      ...((overrides['view'] as Record<string, unknown> | undefined) ?? {}),
    },
    protection: {
      required_status_checks: { contexts: ['ci'] },
      required_pull_request_reviews: { required_approving_review_count: 1 },
      ...((overrides['protection'] as Record<string, unknown> | undefined) ?? {}),
    },
    files: [{ filename: 'docs/guide.md' }],
  };
}

function dependencies(overrides: {
  view?: Record<string, unknown>;
  protection?: Record<string, unknown>;
  files?: Array<{ filename: string }>;
  evalQualifies?: boolean;
  liveQualifies?: boolean;
} = {}) {
  const facts = ghFacts(overrides);
  const gh = vi.fn((args: string[]) => {
    if (args[0] === 'pr') return JSON.stringify(facts.view);
    if (args[1]?.includes('/protection')) return JSON.stringify(facts.protection);
    if (args[1]?.includes('/files?')) return JSON.stringify(overrides.files ?? facts.files);
    throw new Error(`Unexpected gh command: ${args.join(' ')}`);
  });
  const category = (value: AutoMergeRiskCategory) => value;
  return {
    deps: {
      gh,
      evalStreak: vi.fn((risk: AutoMergeRiskCategory) => ({
        passedCount: overrides.evalQualifies === false ? 19 : 20,
        distinctCaseCount: overrides.evalQualifies === false ? 10 : 10,
        requiredCount: 20,
        requiredDistinctCases: 10,
        qualifies: overrides.evalQualifies !== false,
        reason: 'eval unavailable',
      })),
      liveStreak: vi.fn((_deliveryContext: PullRequestDeliveryContext, risk: AutoMergeRiskCategory) => ({
        passedCount: overrides.liveQualifies === false ? 9 : 10,
        requiredCount: 10,
        qualifies: overrides.liveQualifies !== false,
        reason: 'live history unavailable',
      })),
      now: () => new Date('2026-10-16T00:00:00.000Z'),
    },
    gh,
  };
}

const evidence = {
  deterministicConfigured: true,
  deterministicPassed: true,
  reviewPassed: true,
  evidenceStored: true,
};

function liveHistoryFixture(overrides: {
  mergedAt?: string;
  headSha?: string;
  events?: Array<Record<string, unknown>>;
  labels?: Array<{ name: string }>;
} = {}) {
  liveHistoryMocks.known = [{
    repository: 'org/project', prNumber: 7, headSha: 'd'.repeat(40), baseSha: 'a'.repeat(40),
    baseBranch: 'main', category: 'docs', policyFingerprint: 'policy-from-run',
  }];
  liveHistoryMocks.records = [];
  const mergedAt = overrides.mergedAt ?? '2026-09-20T00:00:00.000Z';
  const view = {
    state: 'MERGED', headRefName: 'autodev/76543210', headRefOid: overrides.headSha ?? 'd'.repeat(40),
    baseRefName: 'main', mergedAt, mergedBy: { login: 'human-owner' }, author: { login: 'auto-dev[bot]' },
    reviews: [{ state: 'APPROVED', author: { login: 'human-reviewer' }, commit: { oid: 'd'.repeat(40) } }],
    labels: overrides.labels ?? [{ name: 'auto-dev/merge-stable' }],
  };
  const events = overrides.events ?? [{
    event: 'labeled', label: { name: 'auto-dev/merge-stable' },
    actor: { login: 'human-owner' }, created_at: '2026-10-15T00:00:00.000Z',
  }];
  const gh = vi.fn((args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([{
      number: 7, headRefName: 'autodev/76543210', headRefOid: overrides.headSha ?? 'd'.repeat(40), mergedAt,
      mergedBy: { login: 'human-owner' },
    }]);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(view);
    if (args[0] === 'api') return JSON.stringify(events);
    throw new Error(`Unexpected gh command ${args.join(' ')}`);
  });
  const deliveryContext = {
    workflowRunId: 'run-current', sourceDir: '/repo', worktreeDir: '/repo/worktree', remote: 'origin',
    repository: 'org/project', branch: 'autodev/current', baseBranch: 'main', baseSha: 'a'.repeat(40),
    publicBaseUrl: 'https://auto-dev.example', accessControl: 'authenticated' as const,
    state: { status: 'DELIVERED' as const, prNumber: 42, commitSha: 'b'.repeat(40) },
  };
  return { gh, deliveryContext };
}

describe('synchronizeAutoMergeLiveHistory', () => {
  it('records stability only from a current post-14-day label added by a human', () => {
    const { gh, deliveryContext } = liveHistoryFixture();
    synchronizeAutoMergeLiveHistory(deliveryContext, 'docs', 'policy-current', gh, new Date('2026-10-16T00:00:00.000Z'));

    expect(liveHistoryMocks.records[0]).toMatchObject({
      prNumber: 7,
      category: 'docs',
      outcome: 'stable',
      mergedBy: 'human-owner',
      approvedBy: 'human-reviewer',
      evidenceSource: expect.stringContaining('auto-dev/merge-stable'),
      stabilityVerifiedAt: '2026-10-15T00:00:00.000Z',
    });
  });

  it('records failure labels and leaves unconfirmed, young, or changed-head PRs out of the success streak', () => {
    const reverted = liveHistoryFixture({ events: [{ event: 'labeled', label: { name: 'auto-dev/merge-reverted' }, created_at: '2026-10-15T00:00:00.000Z' }] });
    synchronizeAutoMergeLiveHistory(reverted.deliveryContext, 'docs', 'policy-current', reverted.gh, new Date('2026-10-16T00:00:00.000Z'));
    expect(liveHistoryMocks.records[0]).toMatchObject({ outcome: 'reverted' });

    const young = liveHistoryFixture({ mergedAt: '2026-10-14T00:00:00.000Z' });
    synchronizeAutoMergeLiveHistory(young.deliveryContext, 'docs', 'policy-current', young.gh, new Date('2026-10-16T00:00:00.000Z'));
    expect(liveHistoryMocks.records[0]).toMatchObject({ outcome: 'unknown' });

    const changedHead = liveHistoryFixture({ headSha: 'e'.repeat(40) });
    synchronizeAutoMergeLiveHistory(changedHead.deliveryContext, 'docs', 'policy-current', changedHead.gh, new Date('2026-10-16T00:00:00.000Z'));
    expect(liveHistoryMocks.records[0]).toMatchObject({ outcome: 'unknown', evidenceSource: 'github-observation:verified-head-changed' });

    const botMerged = liveHistoryFixture();
    botMerged.gh.mockImplementation((args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([{
        number: 7, headRefName: 'autodev/76543210', headRefOid: 'd'.repeat(40),
        mergedAt: '2026-09-20T00:00:00.000Z', mergedBy: { login: 'merge-bot[bot]' },
      }]);
      throw new Error(`Unexpected gh command ${args.join(' ')}`);
    });
    synchronizeAutoMergeLiveHistory(botMerged.deliveryContext, 'docs', 'policy-current', botMerged.gh, new Date('2026-10-16T00:00:00.000Z'));
    expect(liveHistoryMocks.records[0]).toMatchObject({ outcome: 'unknown', evidenceSource: 'github-observation:human-merge-not-confirmed' });
  });
});

describe('evaluateAutoMergeDryRun', () => {
  it('reports a qualified candidate without running any merge command', () => {
    const { deps, gh } = dependencies();
    const result = evaluateAutoMergeDryRun({
      context: context(), projectConfig, startingPolicyFingerprint: expectedFingerprint, models, evidence,
      autoMergeEnabledAtStart: true, projectConfigUnchanged: true,
    }, deps);

    expect(result).toMatchObject({ mode: 'dry-run', eligible: true, category: 'docs', eval: { qualifies: true }, live: { qualifies: true } });
    expect(gh.mock.calls.some(([args]) => args.includes('merge'))).toBe(false);
  });

  it('denies a changed head SHA, unknown diff, fingerprint change, or incomplete trust streak', () => {
    const changedHead = dependencies({ view: { headRefOid: 'c'.repeat(40) } });
    expect(evaluateAutoMergeDryRun({ context: context(), projectConfig, startingPolicyFingerprint: expectedFingerprint, models, evidence, autoMergeEnabledAtStart: true, projectConfigUnchanged: true }, changedHead.deps)
      .reasons.join('\n')).toMatch(/head SHA changed/);

    const unknownDiff = dependencies({ files: [{ filename: 'src/index.ts' }] });
    expect(evaluateAutoMergeDryRun({ context: context(), projectConfig, startingPolicyFingerprint: expectedFingerprint, models, evidence, autoMergeEnabledAtStart: true, projectConfigUnchanged: true }, unknownDiff.deps)
      .reasons.join('\n')).toMatch(/outside the protected low-risk allowlists/);

    const missingEval = dependencies({ evalQualifies: false });
    expect(evaluateAutoMergeDryRun({ context: context(), projectConfig, startingPolicyFingerprint: expectedFingerprint, models, evidence, autoMergeEnabledAtStart: true, projectConfigUnchanged: true }, missingEval.deps)
      .reasons.join('\n')).toMatch(/eval unavailable/);

    const changedPolicy = evaluateAutoMergeDryRun({
      context: context(), projectConfig, startingPolicyFingerprint: 'old-policy', models, evidence,
      autoMergeEnabledAtStart: true, projectConfigUnchanged: true,
    }, dependencies().deps);
    expect(changedPolicy.reasons.join('\n')).toMatch(/policy changed/);
  });

  it('requires branch protection, successful required checks, human review, and stored verification evidence', () => {
    const missingProtection = dependencies({ protection: { required_status_checks: undefined } });
    expect(evaluateAutoMergeDryRun({ context: context(), projectConfig, startingPolicyFingerprint: expectedFingerprint, models, evidence, autoMergeEnabledAtStart: true, projectConfigUnchanged: true }, missingProtection.deps)
      .reasons.join('\n')).toMatch(/no required status checks/);

    const failedCheck = dependencies({ view: { statusCheckRollup: [{ name: 'ci', conclusion: 'FAILURE' }] } });
    expect(evaluateAutoMergeDryRun({ context: context(), projectConfig, startingPolicyFingerprint: expectedFingerprint, models, evidence, autoMergeEnabledAtStart: true, projectConfigUnchanged: true }, failedCheck.deps)
      .reasons.join('\n')).toMatch(/not successful/);

    const noHumanReview = dependencies({ view: { reviews: [{ state: 'APPROVED', author: { login: 'auto-dev[bot]' }, commit: { oid: 'b'.repeat(40) } }] } });
    expect(evaluateAutoMergeDryRun({ context: context(), projectConfig, startingPolicyFingerprint: expectedFingerprint, models, evidence, autoMergeEnabledAtStart: true, projectConfigUnchanged: true }, noHumanReview.deps)
      .reasons.join('\n')).toMatch(/no approval from a human reviewer/);

    const noEvidence = evaluateAutoMergeDryRun({
      context: context(), projectConfig, startingPolicyFingerprint: expectedFingerprint, models,
      evidence: { ...evidence, evidenceStored: false },
      autoMergeEnabledAtStart: true, projectConfigUnchanged: true,
    }, dependencies().deps);
    expect(noEvidence.reasons.join('\n')).toMatch(/evidence is not stored/);
  });

  it('does not call GitHub when project opt-in is disabled', () => {
    const { deps, gh } = dependencies();
    const disabled = { ...projectConfig, delivery: { mode: 'pull-request' as const, autoMerge: { enabled: false, requestMerge: false } } };
    const result = evaluateAutoMergeDryRun({
      context: context(), projectConfig: disabled, startingPolicyFingerprint: expectedFingerprint, models, evidence,
      autoMergeEnabledAtStart: false, projectConfigUnchanged: true,
    }, deps);

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('Project auto-merge dry-run was not explicitly enabled at workflow start.');
    expect(gh).not.toHaveBeenCalled();
  });
});
