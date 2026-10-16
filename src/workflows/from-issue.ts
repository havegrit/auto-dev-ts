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
): Promise<ReproPreparation> {
  const projectDir = defaultWorkspaceDir();
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

function beginBugRun(runId: string, issueKey: string, specContent: string): number {
  const startedAt = Date.now();
  insertRun({
    id: runId,
    agentName: 'spec',
    input: specContent.slice(0, 4_000),
    status: 'RUNNING',
    startedAt: new Date(startedAt).toISOString(),
    triggerSource: 'issue',
    triggerDetail: issueKey,
    specSessionId: runId,
  });
  return startedAt;
}

function finishBugRun(
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

export async function processIssue(key: string): Promise<FromIssueResult> {
  const tracker = getIssueTracker();

  if (!tracker.getIssue || !tracker.updateIssue) {
    throw new Error('Issue tracker가 연동되지 않았습니다 (AUTO_DEV_ISSUE_TRACKER_URL 설정 필요)');
  }

  const issue = await tracker.getIssue(key);
  if (!issue) throw new Error(`이슈를 찾을 수 없습니다: ${key}`);

  if (issue.status === 'IN_PROGRESS') {
    throw new Error(`이슈 ${key}는 이미 처리 중입니다 (IN_PROGRESS)`);
  }
  if (issue.status === 'DONE' || issue.status === 'DROPPED') {
    throw new Error(`이슈 ${key}는 이미 종료된 상태입니다 (${issue.status})`);
  }

  const projectConfig = loadProjectConfig(defaultWorkspaceDir());
  if (projectConfig?.delivery?.mode === 'pull-request') {
    throw new Error('Issue-triggered workflows do not support PR delivery yet. Start the spec from the dashboard or CLI.');
  }

  const specContent = buildSpecFromIssue(issue);
  const workflowRunId = randomUUID();
  const bugMode = isBugIssueType(issue.type);
  const bugRunStartedAt = bugMode ? beginBugRun(workflowRunId, key, specContent) : undefined;
  let reproduction: Extract<ReproPreparation, { confirmed: true }> | undefined;

  if (bugMode) {
    try {
      const prepared = await prepareBugReproduction(specContent, workflowRunId, key);
      if (!prepared.confirmed) {
        finishBugRun(workflowRunId, bugRunStartedAt!, 'BLOCKED', prepared.report, prepared.cause);
        return {
          issueKey: key,
          runId: workflowRunId,
          verdict: 'BLOCKED',
          finalStatus: issue.status,
          cause: prepared.cause,
          report: prepared.report,
        };
      }
      reproduction = prepared;
    } catch (err) {
      finishBugRun(
        workflowRunId,
        bugRunStartedAt!,
        'FAILED',
        err instanceof Error ? err.message : String(err),
        'bug_reproduction_error',
      );
      throw err;
    }
  }

  let specResult: SpecResult;
  try {
    await tracker.updateIssue(key, { status: 'IN_PROGRESS', linkedRunId: workflowRunId });
    specResult = await runSpec(specContent, {
      triggerSource: 'issue',
      triggerDetail: key,
      workflowRunId,
      ...(reproduction ? {
        specSessionId: workflowRunId,
        startStep: 'planner' as const,
        initialFeedback: reproduction.feedback,
        reproCommand: reproduction.command,
      } : {}),
    });
  } catch (err) {
    await tracker.updateIssue(key, { status: 'OPEN' });
    if (bugMode) {
      finishBugRun(
        workflowRunId,
        bugRunStartedAt!,
        'FAILED',
        err instanceof Error ? err.message : String(err),
        'workflow_failure',
      );
    }
    throw err;
  }

  const verdict = specResult.verdict ?? 'UNKNOWN';
  const finalStatus = verdict === 'SHIP' ? 'DONE' : issue.status;

  await tracker.updateIssue(key, { status: finalStatus, linkedRunId: workflowRunId });
  if (bugMode) {
    finishBugRun(
      workflowRunId,
      bugRunStartedAt!,
      workflowRunStatus(specResult),
      workflowOutput(specResult),
      specResult.failure?.cause,
    );
  }
  log.info({ issue: key, workflowRunId, verdict, finalStatus }, 'Issue processing complete');

  return {
    issueKey: key,
    runId: workflowRunId,
    verdict,
    finalStatus,
    ...(specResult.failure ? { cause: specResult.failure.cause, report: specResult.failure.reason } : {}),
  };
}

function buildSpecFromIssue(issue: { key: string; title: string; description: string; type: string; priority: string }): string {
  return [
    `# [${issue.key}] ${issue.title}`,
    `타입: ${issue.type} | 우선순위: ${issue.priority}`,
    '',
    issue.description || '(설명 없음)',
  ].join('\n');
}
