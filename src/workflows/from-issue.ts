import { randomUUID } from 'crypto';
import { getIssueTracker } from '../integrations/issue-tracker/index.js';
import { runSpec, type SpecResult } from './spec.js';
import { log } from '../lib/logger.js';

export interface FromIssueResult {
  issueKey: string;
  runId: string;
  verdict: string;
  finalStatus: string;
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

  const specContent = buildSpecFromIssue(issue);

  // runSpec으로 실행하고 runId를 미리 알아야 하므로 백그라운드가 아닌 동기로 실행
  // IN_PROGRESS 마킹은 실행 시작 직전에
  // (spec.ts의 runSpec은 내부에서 parent runId를 생성하므로, 여기서는 execId를 따로 받는다)
  const workflowRunId = randomUUID();

  await tracker.updateIssue(key, { status: 'IN_PROGRESS', linkedRunId: workflowRunId });
  log.info({ issue: key, workflowRunId }, 'Issue processing started');

  let specResult: SpecResult;
  try {
    specResult = await runSpec(specContent, {
      triggerSource: 'issue',
      triggerDetail: key,
      workflowRunId,
    });
  } catch (err) {
    // 실행 자체가 오류 → 이슈 상태를 OPEN으로 돌린다
    await tracker.updateIssue(key, { status: 'OPEN' });
    throw err;
  }

  const verdict = specResult.verdict ?? 'UNKNOWN';
  const finalStatus = verdict === 'SHIP' ? 'DONE' : issue.status;

  await tracker.updateIssue(key, { status: finalStatus, linkedRunId: workflowRunId });
  log.info({ issue: key, workflowRunId, verdict, finalStatus }, 'Issue processing complete');

  return { issueKey: key, runId: workflowRunId, verdict, finalStatus };
}

function buildSpecFromIssue(issue: { key: string; title: string; description: string; type: string; priority: string }): string {
  return [
    `# [${issue.key}] ${issue.title}`,
    `타입: ${issue.type} | 우선순위: ${issue.priority}`,
    '',
    issue.description || '(설명 없음)',
  ].join('\n');
}
