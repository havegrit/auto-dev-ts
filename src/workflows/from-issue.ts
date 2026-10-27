import { randomUUID } from 'node:crypto';
import { test } from '../agents/test.js';
import { getIssueTracker } from '../integrations/issue-tracker/index.js';
import { DEFAULT_VERIFY_TIMEOUT_MS, loadProjectConfig } from '../lib/project-config.js';
import { findRoleBoundaryViolations, snapshotWorkspace } from '../lib/role-boundary.js';
import { defaultWorkspaceDir } from '../lib/workspace.js';
import { emitRunEvent } from '../lib/run-events.js';
import { projectFindingKey, recordOperationalFinding } from '../lib/review-findings.js';
import { insertRun, updateRun } from '../store/runs.js';
import { runSpec, workflowOutput, workflowRunStatus, type SpecResult } from './spec.js';
import { runVerifyStep } from './verify-gate.js';
import { log } from '../lib/logger.js';
import {
  finishIssueExecution,
  expireStaleIssueExecutions,
  heartbeatIssueExecution,
  listDueIssueDeliveries,
  listDueIssueStateUpdates,
  tryAcquireIssueExecution,
  updateIssueExecution,
  type IssueExecutionSource,
} from '../store/issue-executions.js';
import {
  commitIssueWorktree,
  issueWorktreeCheckpoint,
  prepareIssueWorktree,
  pushIssueWorktree,
  remoteIssueBranchSha,
  removePushedIssueWorktree,
  type IssueWorktreeContext,
} from '../lib/issue-worktree.js';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface FromIssueResult {
  issueKey: string;
  runId: string;
  verdict: string;
  finalStatus: string;
  cause?: string;
  report?: string;
}

const DEFAULT_REPRO_TEST_GLOBS = [
  '**/*.test.*', '**/*.spec.*', '**/*Test.*', '**/Test*.*',
  '**/test_*.py', '**/*_test.*', '**/tests/**', '**/test/**', '**/__tests__/**',
];

export function isBugIssueType(type: string): boolean {
  return type.trim().toLowerCase() === 'bug';
}

export function parseReproCommand(output: string): string | undefined {
  const markers = [...output.matchAll(/^\s*\[REPRO:\s*(.+)\]\s*$/gim)];
  const command = markers.at(-1)?.[1]?.trim();
  return command && command.length <= 2_000 ? command : undefined;
}

function bugReproPrompt(specContent: string): string {
  return [
    '## 버그 재현 모드',
    '버그를 재현하는 테스트만 작성하고 실행하라. 프로덕션 코드는 수정하지 마라.',
    '테스트는 실제 버그 동작을 재현해야 한다. 테스트를 실행할 정확한 명령을 마지막 줄에 `[REPRO: <command>]` 형식으로 출력하라.',
    '재현 명령은 대상 프로젝트 디렉터리에서 실행할 수 있어야 한다. 이 단계에서는 `[TESTS: ...]` 마커를 출력하지 마라.',
    '',
    '## 이슈 스펙',
    specContent,
  ].join('\n');
}

type ReproPreparation =
  | { confirmed: true; command: string; feedback: string }
  | { confirmed: false; cause: string; report: string };

async function prepareBugReproduction(
  specContent: string,
  workflowRunId: string,
  issueKey: string,
  projectDir = defaultWorkspaceDir(),
): Promise<ReproPreparation> {
  const projectConfig = loadProjectConfig(projectDir);
  const before = await snapshotWorkspace(projectDir);
  const testRun = await test(bugReproPrompt(specContent), {
    workflowRunId,
    specSessionId: workflowRunId,
    triggerSource: 'issue',
    triggerDetail: `${issueKey}:bug-reproduction-test`,
    cwd: projectDir,
  });

  if (!before) {
    emitRunEvent(testRun.runId, {
      type: 'warn',
      ts: new Date().toISOString(),
      data: 'bug_repro_role_boundary_skipped: not a git repository',
    });
  } else {
    const after = await snapshotWorkspace(projectDir);
    if (!after) {
      emitRunEvent(testRun.runId, {
        type: 'warn',
        ts: new Date().toISOString(),
        data: 'bug_repro_role_boundary_skipped: workspace snapshot unavailable',
      });
    } else {
      const changedFiles = findRoleBoundaryViolations(before, after, {
        testGlobs: projectConfig?.roleBoundary?.testGlobs.length
          ? projectConfig.roleBoundary.testGlobs
          : DEFAULT_REPRO_TEST_GLOBS,
        ignoreGlobs: projectConfig?.roleBoundary?.ignoreGlobs ?? [],
      });
      if (changedFiles.length) {
        for (const file of changedFiles) {
          recordOperationalFinding({
            runId: testRun.runId,
            workflowRunId,
            project: projectFindingKey(projectDir),
            severity: 'high',
            category: 'role-boundary',
            ruleHint: 'bug reproduction test agent must not modify files outside test paths',
            file,
          });
        }
        return {
          confirmed: false,
          cause: 'role_boundary_violation',
          report: `재현 테스트 작성 단계에서 테스트 경로 밖의 파일이 바뀌었다. 되돌리지 않았다: ${changedFiles.join(', ')}`,
        };
      }
    }
  }

  if (testRun.status !== 'DONE') {
    return {
      confirmed: false,
      cause: 'agent_stopped',
      report: testRun.output.trim() || '재현 테스트 작성 에이전트가 완료되지 않았다.',
    };
  }

  const command = parseReproCommand(testRun.output);
  if (!command) {
    return {
      confirmed: false,
      cause: 'invalid_output',
      report: [
        '테스트 에이전트가 유효한 [REPRO: <command>] 마커를 반환하지 않았다.',
        testRun.output.trim(),
      ].filter(Boolean).join('\n\n'),
    };
  }

  const baseline = await runVerifyStep({
    projectDir,
    verify: { command, timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS },
    workflowRunId,
    specSessionId: workflowRunId,
    triggerSource: 'issue',
    triggerDetail: `${issueKey}:bug-reproduction-baseline`,
    expectedOutcome: 'fail',
  });
  if (baseline.outcome.cancelled) {
    return { confirmed: false, cause: 'user_cancelled', report: '재현 명령이 취소되어 버그를 확인하지 못했다.' };
  }
  if (baseline.outcome.timedOut) {
    return { confirmed: false, cause: 'repro_timeout', report: `재현 명령이 제한 시간 안에 끝나지 않았다: ${command}` };
  }
  if (baseline.outcome.exitCode === 0) {
    recordOperationalFinding({
      runId: baseline.runId,
      workflowRunId,
      project: projectFindingKey(projectDir),
      severity: 'high',
      category: 'verify',
      ruleHint: `bug reproduction command did not fail: ${command}`,
    });
    return {
      confirmed: false,
      cause: 'not_reproduced',
      report: `재현 명령이 통과했다. 이미 해결됐거나 재현 정보가 부족하다.\n\n[REPRO: ${command}]\nexit code: 0\n${baseline.outcome.outputTail || '(출력 없음)'}`,
    };
  }
  if (!baseline.passed) {
    recordOperationalFinding({
      runId: baseline.runId,
      workflowRunId,
      project: projectFindingKey(projectDir),
      severity: 'high',
      category: 'verify',
      ruleHint: `bug reproduction command could not confirm failure: ${command}`,
    });
    return {
      confirmed: false,
      cause: 'repro_command_failed',
      report: `재현 명령을 실행했지만 버그 실패를 확인할 수 없었다 (${baseline.outcome.exitCode ?? 'signal'}).\n\n${baseline.outcome.outputTail || '(출력 없음)'}`,
    };
  }

  return {
    confirmed: true,
    command,
    feedback: [
      '버그 재현 테스트가 작성되었고 수정 전 재현 명령이 실패하는 것을 오케스트레이터가 관찰했다.',
      '',
      `[REPRO: ${command}]`,
      `- observed exit code: ${baseline.outcome.exitCode}`,
      `- duration: ${baseline.outcome.durationMs}ms`,
      '',
      '실패 출력을 근거로 원인을 분석하고 구현을 수정하라.',
      '수정 후에는 같은 재현 명령이 통과해야 하며, 이후 전체 검증도 통과해야 한다.',
      '',
      baseline.outcome.outputTail || '(출력 없음)',
    ].join('\n'),
  };
}

function beginIssueRun(runId: string, issueKey: string, specContent: string, requesterId?: string): number {
  const startedAt = Date.now();
  insertRun({
    id: runId,
    agentName: 'spec',
    input: specContent.slice(0, 4_000),
    status: 'RUNNING',
    startedAt: new Date(startedAt).toISOString(),
    triggerSource: 'issue',
    triggerDetail: `${issueKey}${requesterId ? `:requester=${requesterId}` : ''}`,
    specSessionId: runId,
  });
  return startedAt;
}

function finishIssueRun(
  runId: string,
  startedAt: number,
  status: 'DONE' | 'FAILED' | 'BLOCKED',
  output: string,
  cause?: string,
): void {
  updateRun(runId, {
    output,
    status,
    durationMs: Date.now() - startedAt,
    ...(cause ? { errorType: cause, stopReason: cause } : {}),
  });
}

const ISSUE_EXECUTION_CONCURRENCY = Math.max(1, Math.min(4, Number.parseInt(process.env.AUTO_DEV_PLANE_MAX_CONCURRENCY ?? '2', 10) || 2));
const ISSUE_EXECUTION_LEASE_SECONDS = 120;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function plainTextHtml(value: string): string {
  return `<p>${escapeHtml(value).replace(/\r?\n/g, '<br>')}</p>`;
}

async function addIssueComment(
  tracker: ReturnType<typeof getIssueTracker>,
  key: string,
  externalId: string,
  content: string,
): Promise<void> {
  if (!tracker.addComment) return;
  try {
    await tracker.addComment(key, { externalId, html: plainTextHtml(content) });
  } catch (err) {
    log.warn({ issue: key, externalId, err: err instanceof Error ? err.message : String(err) }, 'Failed to write issue comment');
  }
}

function executionBranchSummary(context: IssueWorktreeContext | undefined, sha?: string): string {
  if (!context) return '';
  return `\nBranch: ${context.branch}\nBase: ${context.baseBranch} @ ${context.baseSha}${sha ? `\nCheckpoint: ${sha}` : ''}`;
}

async function commitAndPushIssueWorktree(
  context: IssueWorktreeContext,
  kind: 'success' | 'wip',
  details: string,
  executionId: string,
  targetStatus: string,
): Promise<{ sha?: string; pushed?: boolean; pushError?: string }> {
  const sha = await commitIssueWorktree(context, kind, details);
  if (!sha) return {};
  updateIssueExecution(executionId, {
    commit_sha: sha,
    target_status: targetStatus,
    retry_at: new Date(Date.now() + 60_000).toISOString(),
  });
  try {
    await pushIssueWorktree(context, sha);
  } catch (err) {
    const pushError = err instanceof Error ? err.message : String(err);
    updateIssueExecution(executionId, {
      status: 'DELIVERY_PENDING',
      commit_sha: sha,
      target_status: targetStatus,
      retry_at: new Date(Date.now() + 60_000).toISOString(),
      last_error: pushError,
    });
    return { sha, pushError };
  }
  // Local cleanup is allowed only after the remote branch has the exact commit.
  updateIssueExecution(executionId, {
    status: 'DELIVERY_PENDING',
    commit_sha: sha,
    target_status: targetStatus,
    retry_at: new Date(Date.now() + 60_000).toISOString(),
    last_error: undefined,
  });
  return { sha, pushed: true };
}

async function cleanupPushedIssueWorktree(context: IssueWorktreeContext | undefined, sha: string | undefined): Promise<void> {
  if (!context || !sha) return;
  try {
    await removePushedIssueWorktree(context, sha);
  } catch (err) {
    log.warn({ issue: context.issueKey, branch: context.branch, err: err instanceof Error ? err.message : String(err) }, 'Pushed issue worktree cleanup failed');
  }
}

export async function processIssue(key: string, source: IssueExecutionSource = 'cli'): Promise<FromIssueResult> {
  const tracker = getIssueTracker();

  if (!tracker.getIssue || !tracker.updateIssue) {
    throw new Error('Issue tracker가 연동되지 않았습니다 (AUTO_DEV_ISSUE_TRACKER_URL 설정 필요)');
  }

  const issue = await tracker.getIssue(key);
  if (!issue) throw new Error(`이슈를 찾을 수 없습니다: ${key}`);
  if (tracker.provider === 'plane' && issue.status !== 'OPEN') {
    throw new Error(`Plane 이슈 ${key}가 AI 대기 상태가 아닙니다 (${issue.status})`);
  }
  if (issue.status === 'IN_PROGRESS') throw new Error(`이슈 ${key}는 이미 처리 중입니다 (IN_PROGRESS)`);
  if (issue.status === 'DONE' || issue.status === 'DROPPED' || issue.status === 'HUMAN_REVIEW') {
    throw new Error(`이슈 ${key}는 자동 실행 대상이 아닙니다 (${issue.status})`);
  }

  const sourceDir = resolve(defaultWorkspaceDir());
  const projectConfig = loadProjectConfig(sourceDir);
  if (projectConfig?.delivery?.mode === 'pull-request') {
    throw new Error('Issue-triggered workflows do not support PR delivery yet. Start the spec from the dashboard or CLI.');
  }

  const workflowRunId = randomUUID();
  const leaseToken = randomUUID();
  const acquire = tryAcquireIssueExecution({
    id: workflowRunId,
    issueKey: key,
    providerIssueId: issue.id,
    source,
    leaseToken,
    sourceDir,
    maxConcurrency: ISSUE_EXECUTION_CONCURRENCY,
    leaseSeconds: ISSUE_EXECUTION_LEASE_SECONDS,
  });
  if (!acquire.acquired) {
    throw new Error(acquire.reason === 'duplicate'
      ? `이슈 ${key}는 이미 auto-dev에서 실행 중입니다.`
      : `Plane 동시 실행 한도(${ISSUE_EXECUTION_CONCURRENCY})에 도달했습니다.`);
  }

  const specContent = buildSpecFromIssue(issue);
  const runStartedAt = beginIssueRun(workflowRunId, key, specContent, issue.requesterId);
  const heartbeatTimer = setInterval(() => {
    try {
      if (!heartbeatIssueExecution(workflowRunId, leaseToken, ISSUE_EXECUTION_LEASE_SECONDS)) {
        log.warn({ issue: key, workflowRunId }, 'Issue execution lease was lost');
      }
    } catch (err) {
      log.error({ issue: key, workflowRunId, err: err instanceof Error ? err.message : String(err) }, 'Issue execution heartbeat failed');
    }
  }, 30_000);
  heartbeatTimer.unref?.();
  const plane = tracker.provider === 'plane';
  const bugMode = isBugIssueType(issue.type);
  let worktree: IssueWorktreeContext | undefined;
  let branchSha: string | undefined;
  let branchPushed = false;
  let deliveryPending = false;
  let deliveryTargetStatus = plane ? 'HUMAN_REVIEW' : issue.status;
  let issueStatusChanged = false;
  let executionFinalized = false;

  try {
    if (plane) {
      worktree = await prepareIssueWorktree(sourceDir, workflowRunId, key, projectConfig?.delivery?.baseBranch);
      updateIssueExecution(workflowRunId, {
        remote: worktree.remote,
        branch_name: worktree.branch,
        base_branch: worktree.baseBranch,
        base_sha: worktree.baseSha,
        worktree_path: worktree.worktreeDir,
      });
    }
    const executionDir = worktree?.worktreeDir ?? sourceDir;

    let reproduction: Extract<ReproPreparation, { confirmed: true }> | undefined;
    if (bugMode) {
      const prepared = await prepareBugReproduction(specContent, workflowRunId, key, executionDir);
      if (!prepared.confirmed) {
        const finalStatus = plane ? 'HUMAN_REVIEW' : issue.status;
        let pendingError: string | undefined;
        if (worktree) {
          const delivery = await commitAndPushIssueWorktree(worktree, 'wip', prepared.report, workflowRunId, finalStatus);
          branchSha = delivery.sha;
          branchPushed = delivery.pushed === true;
          pendingError = delivery.pushError;
          deliveryPending = Boolean(delivery.pushError);
        }
        if (pendingError) {
          await addIssueComment(tracker, key, `${workflowRunId}:delivery`,
            `auto-dev 재현 단계에서 멈췄고 WIP push가 대기 중입니다.\n${executionBranchSummary(worktree, branchSha)}\n오류: ${pendingError}`);
          finishIssueRun(workflowRunId, runStartedAt, 'BLOCKED', prepared.report, prepared.cause);
          return { issueKey: key, runId: workflowRunId, verdict: 'DELIVERY_PENDING', finalStatus: 'IN_PROGRESS', cause: 'push_pending', report: pendingError };
        }
        if (plane) await tracker.updateIssue(key, { status: finalStatus, linkedRunId: workflowRunId });
        await addIssueComment(tracker, key, `${workflowRunId}:outcome`,
          `auto-dev 버그 재현 단계가 중단되었습니다. 원인: ${prepared.cause}\n${prepared.report}${executionBranchSummary(worktree)}`);
        finishIssueRun(workflowRunId, runStartedAt, 'BLOCKED', prepared.report, prepared.cause);
        finishIssueExecution(workflowRunId, plane ? 'HUMAN_REVIEW' : 'FAILED', { error: prepared.report });
        executionFinalized = true;
        await cleanupPushedIssueWorktree(worktree, branchSha);
        return { issueKey: key, runId: workflowRunId, verdict: 'BLOCKED', finalStatus, cause: prepared.cause, report: prepared.report };
      }
      reproduction = prepared;
      await addIssueComment(tracker, key, `${workflowRunId}:reproduction`,
        `auto-dev 버그 재현 기준선 확인 완료.\n명령: ${prepared.command}\n\n${prepared.feedback.slice(0, 2_000)}${executionBranchSummary(worktree)}`);
    }

    await tracker.updateIssue(key, { status: 'IN_PROGRESS', linkedRunId: workflowRunId });
    issueStatusChanged = true;

    let specResult: SpecResult;
    try {
      specResult = await runSpec(specContent, {
        triggerSource: 'issue',
        triggerDetail: `${key}${issue.requesterId ? `:requester=${issue.requesterId}` : ''}`,
        workflowRunId,
        cwd: executionDir,
        projectConfigDir: sourceDir,
        awaitPostSuccess: true,
        testRepairLimit: 2,
        onStageResult: async (stage) => {
          const checkpoint = worktree ? await issueWorktreeCheckpoint(worktree) : undefined;
          const eventData = {
            issueKey: key,
            stage: stage.stage,
            status: stage.status,
            runId: stage.runId,
            headSha: checkpoint?.headSha,
            changedPaths: checkpoint?.changedPaths,
          };
          try {
            emitRunEvent(stage.runId, { type: 'status', ts: new Date().toISOString(), data: `issue_checkpoint:${JSON.stringify(eventData)}` });
          } catch (err) {
            log.warn({ issue: key, stage: stage.stage, err: err instanceof Error ? err.message : String(err) }, 'Failed to store issue checkpoint event');
          }
          const rationale = stage.output?.trim().slice(-2_500) ?? '';
          await addIssueComment(tracker, key, `${workflowRunId}:stage:${stage.stage}:${stage.runId}`,
            `auto-dev ${stage.stage}: ${stage.status}\n실행: ${stage.runId}${checkpoint ? `\nGit HEAD: ${checkpoint.headSha}\n변경 경로: ${checkpoint.changedPaths.join(', ') || '(없음)'}` : ''}${rationale ? `\n\n결정/결과:\n${rationale}` : ''}`);
        },
        ...(reproduction ? {
          specSessionId: workflowRunId,
          startStep: 'planner' as const,
          initialFeedback: reproduction.feedback,
          reproCommand: reproduction.command,
        } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finishIssueRun(workflowRunId, runStartedAt, 'FAILED', message, 'workflow_failure');
      if (worktree) {
        const delivery = await commitAndPushIssueWorktree(worktree, 'wip', `Workflow error: ${message}`, workflowRunId, 'HUMAN_REVIEW');
        branchSha = delivery.sha;
        branchPushed = delivery.pushed === true;
        if (delivery.pushError) {
          deliveryPending = true;
          await addIssueComment(tracker, key, `${workflowRunId}:delivery`,
            `auto-dev WIP 브랜치 push가 대기 중입니다.\n${executionBranchSummary(worktree, delivery.sha)}\n오류: ${delivery.pushError}`);
          return { issueKey: key, runId: workflowRunId, verdict: 'DELIVERY_PENDING', finalStatus: 'IN_PROGRESS', cause: 'push_pending', report: delivery.pushError };
        }
      }
      await tracker.updateIssue(key, { status: plane ? 'HUMAN_REVIEW' : 'OPEN', linkedRunId: workflowRunId });
      issueStatusChanged = true;
      finishIssueExecution(workflowRunId, plane ? 'HUMAN_REVIEW' : 'FAILED', { error: message });
      executionFinalized = true;
      await cleanupPushedIssueWorktree(worktree, branchSha);
      await addIssueComment(tracker, key, `${workflowRunId}:outcome`,
        `auto-dev 실행이 오류로 중단되었습니다.\n${message}${executionBranchSummary(worktree)}`);
      throw err;
    }

    const verdict = specResult.verdict ?? 'UNKNOWN';
    const successful = verdict === 'SHIP' && !specResult.postSuccessFailure;
    const finalStatus = successful ? 'DONE' : plane ? 'HUMAN_REVIEW' : issue.status;
    const failureText = specResult.failure?.reason ?? specResult.postSuccessFailure;
    const finalRunStatus = specResult.postSuccessFailure ? 'FAILED' : workflowRunStatus(specResult);
    const finalRunOutput = `${workflowOutput(specResult)}${specResult.postSuccessFailure ? `\n\nPost-success failure:\n${specResult.postSuccessFailure}` : ''}`;
    const report = [
      `auto-dev 결과: ${verdict}`,
      `최종 상태: ${finalStatus}`,
      `테스트 수정 재시도: ${specResult.testRepairCount ?? 0}/2`,
      ...(specResult.planOutput ? [`\n결정 근거:\n${specResult.planOutput.slice(0, 3_000)}`] : []),
      ...(failureText ? [`\n확인 필요:\n${failureText.slice(0, 3_000)}`] : []),
      executionBranchSummary(worktree),
    ].join('\n');

    let commitSha: string | undefined;
    if (worktree) {
      const delivery = await commitAndPushIssueWorktree(worktree, successful ? 'success' : 'wip', report, workflowRunId, finalStatus);
      commitSha = delivery.sha;
      branchSha = delivery.sha;
      branchPushed = delivery.pushed === true;
      deliveryTargetStatus = finalStatus;
      if (delivery.pushError) {
        deliveryPending = true;
        await addIssueComment(tracker, key, `${workflowRunId}:delivery`,
          `auto-dev 결과는 ${verdict}입니다. Git 전달을 재시도합니다.\n${executionBranchSummary(worktree, delivery.sha)}\n오류: ${delivery.pushError}`);
        finishIssueRun(workflowRunId, runStartedAt, finalRunStatus, finalRunOutput, specResult.failure?.cause ?? (specResult.postSuccessFailure ? 'post_success_failure' : undefined));
        return { issueKey: key, runId: workflowRunId, verdict, finalStatus: 'IN_PROGRESS', cause: 'push_pending', report: delivery.pushError };
      }
    }

    await tracker.updateIssue(key, { status: finalStatus, linkedRunId: workflowRunId });
    issueStatusChanged = true;
    finishIssueRun(
      workflowRunId,
      runStartedAt,
      finalRunStatus,
      finalRunOutput,
      specResult.failure?.cause ?? (specResult.postSuccessFailure ? 'post_success_failure' : undefined),
    );
    finishIssueExecution(workflowRunId, successful ? 'DONE' : 'HUMAN_REVIEW', {
      ...(failureText ? { error: failureText } : {}),
      ...(commitSha ? { commitSha } : {}),
    });
    executionFinalized = true;
    await cleanupPushedIssueWorktree(worktree, commitSha);
    await addIssueComment(tracker, key, `${workflowRunId}:outcome`, `${report}${executionBranchSummary(worktree, commitSha)}`);
    log.info({ issue: key, workflowRunId, verdict, finalStatus, branch: worktree?.branch, commitSha }, 'Issue processing complete');

    return {
      issueKey: key,
      runId: workflowRunId,
      verdict,
      finalStatus,
      ...(specResult.failure ? { cause: specResult.failure.cause, report: specResult.failure.reason } : {}),
      ...(specResult.postSuccessFailure ? { cause: 'post_success_failure', report: specResult.postSuccessFailure } : {}),
    };
  } catch (err) {
    if (!executionFinalized) {
      const message = err instanceof Error ? err.message : String(err);
      if (worktree && !branchPushed && !deliveryPending) {
        try {
          const delivery = await commitAndPushIssueWorktree(worktree, 'wip', `Issue execution error: ${message}`, workflowRunId, 'HUMAN_REVIEW');
          branchSha = delivery.sha;
          branchPushed = delivery.pushed === true;
          deliveryPending = Boolean(delivery.pushError);
          deliveryTargetStatus = 'HUMAN_REVIEW';
        } catch (deliveryErr) {
          log.error({ issue: key, err: deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr) }, 'Failed to checkpoint issue worktree after error');
        }
      }

      if (branchPushed) {
        try {
          await tracker.updateIssue(key, { status: deliveryTargetStatus, linkedRunId: workflowRunId });
          finishIssueExecution(workflowRunId, deliveryTargetStatus === 'DONE' ? 'DONE' : 'HUMAN_REVIEW', { commitSha: branchSha });
          await cleanupPushedIssueWorktree(worktree, branchSha);
        } catch (updateErr) {
          deliveryPending = true;
          updateIssueExecution(workflowRunId, {
            status: 'DELIVERY_PENDING',
            target_status: deliveryTargetStatus,
            retry_at: new Date(Date.now() + 60_000).toISOString(),
            last_error: updateErr instanceof Error ? updateErr.message : String(updateErr),
          });
          log.error({ issue: key, err: updateErr instanceof Error ? updateErr.message : String(updateErr) }, 'Failed to update Plane issue after Git delivery');
        }
      } else if (!deliveryPending) {
        const finalStatus = plane ? 'HUMAN_REVIEW' : issueStatusChanged ? 'OPEN' : issue.status;
        try {
          if (issueStatusChanged || plane) await tracker.updateIssue(key, { status: finalStatus, linkedRunId: workflowRunId });
        } catch (updateErr) {
          log.error({ issue: key, err: updateErr instanceof Error ? updateErr.message : String(updateErr) }, 'Failed to update issue after execution error');
        }
        finishIssueExecution(workflowRunId, plane ? 'HUMAN_REVIEW' : 'FAILED', { error: message });
      }
      finishIssueRun(workflowRunId, runStartedAt, 'FAILED', message, 'issue_execution_error');
      await addIssueComment(tracker, key, `${workflowRunId}:error`, `auto-dev 실행이 시작되지 않았습니다.\n${message}${executionBranchSummary(worktree)}`);
      executionFinalized = true;
    }
    throw err;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export async function retryPendingIssueDeliveries(): Promise<void> {
  const tracker = getIssueTracker();
  if (tracker.provider !== 'plane' || !tracker.updateIssue) return;
  for (const execution of listDueIssueDeliveries()) {
    if (!execution.worktree_path || !execution.branch_name || !execution.base_branch || !execution.base_sha || !execution.remote || !execution.target_status) {
      const error = 'Delivery retry is missing its persisted Git context.';
      updateIssueExecution(execution.id, { last_error: error, retry_at: new Date(Date.now() + 5 * 60_000).toISOString() });
      log.error({ issue: execution.issue_key, executionId: execution.id }, error);
      continue;
    }
    const context: IssueWorktreeContext = {
      sourceDir: execution.source_dir,
      worktreeDir: execution.worktree_path,
      remote: execution.remote,
      branch: execution.branch_name,
      baseBranch: execution.base_branch,
      baseSha: execution.base_sha,
      workflowRunId: execution.id,
      issueKey: execution.issue_key,
    };
    try {
      await access(context.worktreeDir);
      const sha = execution.commit_sha ?? await remoteIssueBranchSha(context);
      if (!sha) throw new Error('No local or remote commit was found for the pending issue branch.');
      await pushIssueWorktree(context, sha);
      updateIssueExecution(execution.id, { commit_sha: sha });
      await tracker.updateIssue(execution.issue_key, { status: execution.target_status, linkedRunId: execution.id });
      finishIssueExecution(execution.id, execution.target_status === 'DONE' ? 'DONE' : 'HUMAN_REVIEW', { commitSha: sha });
      await cleanupPushedIssueWorktree(context, sha);
      await addIssueComment(tracker, execution.issue_key, `${execution.id}:delivery`,
        `auto-dev Git 전달이 완료되었습니다.\n브랜치: ${execution.branch_name}\n커밋: ${sha}\nPlane 상태: ${execution.target_status}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateIssueExecution(execution.id, {
        retry_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        last_error: message,
      });
      log.error({ issue: execution.issue_key, branch: execution.branch_name, err: message }, 'Issue Git delivery retry failed');
    }
  }
}

export async function recoverExpiredPlaneIssueExecutions(): Promise<void> {
  const tracker = getIssueTracker();
  if (tracker.provider !== 'plane' || !tracker.updateIssue) return;
  const pending = new Map(
    [...expireStaleIssueExecutions(), ...listDueIssueStateUpdates()]
      .map((execution) => [execution.id, execution] as const),
  );
  for (const execution of pending.values()) {
    try {
      const targetStatus = execution.target_status ?? 'HUMAN_REVIEW';
      await tracker.updateIssue(execution.issue_key, { status: targetStatus, linkedRunId: execution.id });
      finishIssueExecution(execution.id, 'HUMAN_REVIEW', { error: execution.last_error });
      await addIssueComment(tracker, execution.issue_key, `${execution.id}:lease-expired`,
        `auto-dev 실행 lease가 만료되어 자동 실행을 멈췄습니다. worktree와 브랜치를 보존했습니다.\n브랜치: ${execution.branch_name ?? '(생성 전)'}\n오류: ${execution.last_error ?? '서버가 실행 중 재시작됨'}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateIssueExecution(execution.id, {
        status: 'STATE_UPDATE_PENDING',
        target_status: execution.target_status ?? 'HUMAN_REVIEW',
        retry_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        last_error: message,
      });
      log.error({ issue: execution.issue_key, executionId: execution.id, err: message }, 'Failed to recover expired Plane issue execution');
    }
  }
}

function buildSpecFromIssue(issue: { key: string; title: string; description: string; type: string; priority: string; requesterId?: string }): string {
  return [
    `# [${issue.key}] ${issue.title}`,
    `타입: ${issue.type} | 우선순위: ${issue.priority}`,
    ...(issue.requesterId ? [`요청자 ID: ${issue.requesterId}`] : []),
    '',
    issue.description || '(설명 없음)',
  ].join('\n');
}
