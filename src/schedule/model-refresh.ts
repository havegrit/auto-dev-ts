import cron from 'node-cron';
import { loadModelsFromCli } from '../lib/model-config.js';
import { log } from '../lib/logger.js';

const CRON_EXPR = '0 9 * * 0';
let scheduled = false;

export function startModelRefreshSchedule(): void {
  if (scheduled) return;
  scheduled = true;

  cron.schedule(CRON_EXPR, async () => {
    log.info({ schedule: 'model-refresh' }, 'Refreshing provider model catalogs');
    await loadModelsFromCli();
  }, { timezone: 'Asia/Seoul' });

  log.info({ schedule: 'model-refresh', cron: CRON_EXPR, timezone: 'Asia/Seoul' }, 'Provider model refresh scheduled');
}
