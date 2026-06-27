import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';

describe('codexModelCatalog', () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  afterEach(() => {
    process.env = originalEnv;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('includes configured global, fallback, and agent-specific models', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-dev-codex-models-'));
    tempDirs.push(dir);
    process.env.AUTO_DEV_CONFIG_PATH = join(dir, 'config.json');
    process.env.AUTO_DEV_MODEL = 'gpt-5';
    process.env.AUTO_DEV_FALLBACK_MODEL = 'gpt-5-mini';
    process.env.AUTO_DEV_AGENT_SCAFFOLD_MODEL = 'gpt-5-codex';
    vi.resetModules();
    const { codexModelCatalog } = await import('./models.js');

    const models = await codexModelCatalog.listModels();

    expect(models.map(m => m.id)).toEqual(['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5', 'gpt-5-mini', 'gpt-5-codex']);
  });
});
