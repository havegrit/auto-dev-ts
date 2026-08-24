import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';

const execCommand = vi.fn();
vi.mock('./process.js', () => ({
  execCommand: (...args: unknown[]) => execCommand(...args),
}));

describe('codexModelCatalog', () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  afterEach(() => {
    process.env = originalEnv;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    execCommand.mockReset();
  });

  it('falls back to the static list when codex debug models fails, still merging configured models', async () => {
    execCommand.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'not logged in' });
    const dir = mkdtempSync(join(tmpdir(), 'auto-dev-codex-models-'));
    tempDirs.push(dir);
    process.env.AUTO_DEV_CONFIG_PATH = join(dir, 'config.json');
    process.env.AUTO_DEV_MODEL = 'gpt-5';
    process.env.AUTO_DEV_FALLBACK_MODEL = 'gpt-5-mini';
    process.env.AUTO_DEV_AGENT_SCAFFOLD_MODEL = 'gpt-5-codex';
    vi.resetModules();
    const { codexModelCatalog } = await import('./models.js');

    const models = await codexModelCatalog.listModels();

    expect(models.map(m => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-5', 'gpt-5-mini', 'gpt-5-codex']);
  });

  it('uses the live catalog from codex debug models when it succeeds, sorted by priority and filtered to visibility=list', async () => {
    execCommand.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        models: [
          { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', description: 'balanced', visibility: 'list', priority: 2, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
          { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', description: 'frontier', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }] },
          { slug: 'codex-auto-review', display_name: 'Codex Auto Review', description: 'internal', visibility: 'hide', priority: 43, supported_reasoning_levels: [] },
        ],
      }),
      stderr: '',
    });
    const dir = mkdtempSync(join(tmpdir(), 'auto-dev-codex-models-'));
    tempDirs.push(dir);
    process.env.AUTO_DEV_CONFIG_PATH = join(dir, 'config.json');
    delete process.env.AUTO_DEV_MODEL;
    delete process.env.AUTO_DEV_FALLBACK_MODEL;
    delete process.env.AUTO_DEV_AGENT_SCAFFOLD_MODEL;
    vi.resetModules();
    const { codexModelCatalog } = await import('./models.js');

    const models = await codexModelCatalog.listModels();

    // priority 순 정렬, visibility=hide 는 제외, effortLevels 는 'none' + provider 값.
    expect(models).toEqual([
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: 'frontier', effortLevels: ['none', 'low', 'xhigh'] },
      { id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', description: 'balanced', effortLevels: ['none', 'low', 'high'] },
    ]);
  });
});
