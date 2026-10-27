import cron from 'node-cron';
import { getIssueTracker } from '../integrations/issue-tracker/index.js';
import { log } from '../lib/logger.js';
import { processIssue, recoverExpiredPlaneIssueExecutions, retryPendingIssueDeliveries } from '../workflows/from-issue.js';

const CRON_EXPR = process.env.AUTO_DEV_PLANE_POLL_CRON?.trim() || '*/2 * * * *';
let scheduled = false;
let pollRunning = false;

export async function pollPlaneIssues(): Promise<void> {
  if (pollRunning) return;
  pollRunning = true;
  try {
    const tracker = getIssueTracker();
    if (tracker.provider !== 'plane') return;
    await retryPendingIssueDeliveries();
    await recoverExpiredPlaneIssueExecutions();
    const issues = await tracker.fetchOpenIssues();
    for (const issue of issues) {
      if (issue.status !== 'OPEN') continue;
      void processIssue(issue.key, 'poll').catch((err) => {
        log.error({ issue: issue.key, err: err instanceof Error ? err.message : String(err) }, 'Plane issue poll execution failed');
      });
    }
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Plane issue poll failed');
  } finally {
    pollRunning = false;
  }
}

export function startPlaneIssueSchedule(): void {
  if (scheduled) return;
  let tracker: ReturnType<typeof getIssueTracker>;
  try {
    tracker = getIssueTracker();
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Plane issue schedule was not started because its configuration is invalid');
    return;
  }
  if (tracker.provider !== 'plane') return;
  if (!cron.validate(CRON_EXPR)) {
    log.error({ cron: CRON_EXPR }, 'Plane issue poll cron expression is invalid');
    return;
  }
  scheduled = true;
  cron.schedule(CRON_EXPR, () => { void pollPlaneIssues(); }, { timezone: 'Asia/Seoul' });
  log.info({ schedule: 'plane-issues', cron: CRON_EXPR, timezone: 'Asia/Seoul' }, 'Plane issue polling scheduled');
  void pollPlaneIssues();
}
