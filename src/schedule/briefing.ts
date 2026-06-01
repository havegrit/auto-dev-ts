import cron from 'node-cron';
import { review } from '../agents/review/index.js';
import { log } from '../lib/logger.js';

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
      let content: string;
      try {
        content = readFileSync(WORKLOG_PATH, 'utf-8');
      } catch {
        log.warn({ schedule: 'briefing', path: WORKLOG_PATH }, 'Worklog file not found, skipping');
        return;
      }
      const result = await review(content, { triggerSource: 'schedule', triggerDetail: 'daily-briefing' });
      log.info({ schedule: 'briefing', runId: result.runId, durationMs: result.durationMs }, 'Briefing complete');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ schedule: 'briefing', err: msg }, 'Briefing failed');
    }
  }, { timezone: 'Asia/Seoul' });

  log.info({ schedule: 'briefing', cron: CRON_EXPR }, 'Worklog briefing scheduled');
}
