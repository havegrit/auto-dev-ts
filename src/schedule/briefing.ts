import cron from 'node-cron';
import { review } from '../agents/review/index.js';
import { log } from '../lib/logger.js';
import { getIssueTracker } from '../integrations/issue-tracker/index.js';

const ENABLED = process.env.AUTO_DEV_WORKLOG_BRIEFING_ENABLED === 'true';
const CRON_EXPR = process.env.AUTO_DEV_WORKLOG_BRIEFING_CRON ?? '0 9 * * *';
const WORKLOG_PATH = process.env.AUTO_DEV_WORKLOG_PATH ?? './data/worklog.md';

export function startBriefingSchedule(): void {
  if (!ENABLED) {
    log.info({ schedule: 'briefing' }, 'Worklog briefing disabled');
    return;
  }

  cron.schedule(CRON_EXPR, async () => {
    log.info({ schedule: 'briefing' }, 'Running daily worklog briefing');
    try {
      const { readFileSync } = await import('fs');
      let worklog = '';
      try {
        worklog = readFileSync(WORKLOG_PATH, 'utf-8');
      } catch {
        log.warn({ schedule: 'briefing', path: WORKLOG_PATH }, 'Worklog file not found');
      }

      const tracker = getIssueTracker();
      let issueSummary = '(이슈 없음 — 트래커 미연동)';
      try {
        const issues = await tracker.fetchOpenIssues();
        if (issues.length > 0) {
          issueSummary = issues
            .map(i => `- [${i.key}] ${i.title} (${i.priority}/${i.status})`)
            .join('\n');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ schedule: 'briefing', err: msg }, 'Failed to fetch issues');
      }

      const prompt = [
        '오늘의 워크로그 브리핑.',
        '',
        '할당된 이슈:',
        issueSummary,
        '',
        worklog ? `워크로그:\n${worklog}` : '',
        '',
        '먼저 시작할 작업과 고려할 점을 3줄 이내로 요약.',
      ].join('\n').trim();

      const result = await review(prompt, { triggerSource: 'schedule', triggerDetail: 'daily-briefing' });
      log.info({ schedule: 'briefing', runId: result.runId, durationMs: result.durationMs }, 'Briefing complete');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ schedule: 'briefing', err: msg }, 'Briefing failed');
    }
  }, { timezone: 'Asia/Seoul' });

  log.info({ schedule: 'briefing', cron: CRON_EXPR }, 'Worklog briefing scheduled');
}
