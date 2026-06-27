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
    });

    const reloaded = await freshStore(join(dir, 'nested', 'config.json'));
    expect(reloaded.appConfig.get()).toEqual({
      model: 'global-model',
      fallbackModel: 'fallback-model',
      effort: 'medium',
      agentModels: { scaffold: 'agent-model' },
    });
  });
});
