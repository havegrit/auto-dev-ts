import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dirs: string[] = [];

async function freshStore(path: string) {
  vi.resetModules();
  process.env.AUTO_DEV_CONFIG_PATH = path;
  return import('./app-config.js');
}

describe('appConfig', () => {
  afterEach(() => {
    delete process.env.AUTO_DEV_CONFIG_PATH;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('persists runtime model settings without editing env files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-dev-config-'));
    dirs.push(dir);
    const { appConfig } = await freshStore(join(dir, 'nested', 'config.json'));

    appConfig.save({
      model: 'global-model',
      fallbackModel: 'fallback-model',
      effort: 'medium',
      agentModels: { scaffold: 'agent-model' },
      agentEfforts: { scaffold: 'low' },
    });

    const reloaded = await freshStore(join(dir, 'nested', 'config.json'));
    expect(reloaded.appConfig.get()).toEqual({
      model: 'global-model',
      fallbackModel: 'fallback-model',
      effort: 'medium',
      agentModels: { scaffold: 'agent-model' },
      agentEfforts: { scaffold: 'low' },
    });
  });

  it('persists the global auto-merge kill switch and defaults malformed values off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-dev-config-'));
    dirs.push(dir);
    const path = join(dir, 'runtime-config.json');
    const { appConfig } = await freshStore(path);
    expect(appConfig.get().autoMergeEnabled).toBeUndefined();
    appConfig.save({ autoMergeEnabled: true });
    expect(appConfig.get().autoMergeEnabled).toBe(true);

    const reloaded = await freshStore(path);
    expect(reloaded.appConfig.get().autoMergeEnabled).toBe(true);
    reloaded.appConfig.save({ autoMergeEnabled: false });
    expect(reloaded.appConfig.get().autoMergeEnabled).toBe(false);
  });
});
