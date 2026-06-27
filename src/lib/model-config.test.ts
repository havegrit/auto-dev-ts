import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const listedModels = vi.hoisted(() => ({
  value: [
    { id: 'codex-cli:fast-model', provider: 'codex-cli', providerModel: 'fast-model', displayName: 'Fast Model', effortLevels: ['low', 'high'] },
    { id: 'anthropic:fallback-model', provider: 'anthropic', providerModel: 'fallback-model', displayName: 'Fallback Model', effortLevels: ['low', 'medium', 'high'] },
    { id: 'anthropic:global-model', provider: 'anthropic', providerModel: 'global-model', displayName: 'Global Model', effortLevels: ['high'] },
  ],
}));

vi.mock('./logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../llm/registry.js', () => ({
  getModelCatalog: () => ({
    listModels: vi.fn(async () => listedModels.value),
  }),
}));

async function freshConfig() {
  vi.resetModules();
  return import('./model-config.js');
}

describe('modelConfig model resolution', () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  beforeEach(() => {
    process.env = { ...originalEnv };
    const dir = mkdtempSync(join(tmpdir(), 'auto-dev-model-config-'));
    tempDirs.push(dir);
    process.env.AUTO_DEV_CONFIG_PATH = join(dir, 'config.json');
    delete process.env.AUTO_DEV_MODEL;
    delete process.env.AUTO_DEV_FALLBACK_MODEL;
    delete process.env.AUTO_DEV_AGENT_SCAFFOLD_MODEL;
    listedModels.value = [
      { id: 'codex-cli:fast-model', provider: 'codex-cli', providerModel: 'fast-model', displayName: 'Fast Model', effortLevels: ['low', 'high'] },
      { id: 'anthropic:fallback-model', provider: 'anthropic', providerModel: 'fallback-model', displayName: 'Fallback Model', effortLevels: ['low', 'medium', 'high'] },
      { id: 'anthropic:global-model', provider: 'anthropic', providerModel: 'global-model', displayName: 'Global Model', effortLevels: ['high'] },
    ];
  });

  afterEach(() => {
    process.env = originalEnv;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('uses the agent-specific model when it is available', async () => {
    process.env.AUTO_DEV_MODEL = 'anthropic:global-model';
    process.env.AUTO_DEV_FALLBACK_MODEL = 'anthropic:fallback-model';
    process.env.AUTO_DEV_AGENT_SCAFFOLD_MODEL = 'codex-cli:fast-model';
    const { loadModelsFromCli, modelConfig } = await freshConfig();

    await loadModelsFromCli();

    expect(modelConfig.getModelForAgent('scaffold')).toBe('fast-model');
    expect(modelConfig.getProviderForAgent('scaffold')).toBe('codex-cli');
  });

  it('uses the fallback model when the agent-specific model is unavailable', async () => {
    process.env.AUTO_DEV_MODEL = 'anthropic:global-model';
    process.env.AUTO_DEV_FALLBACK_MODEL = 'anthropic:fallback-model';
    process.env.AUTO_DEV_AGENT_SCAFFOLD_MODEL = 'missing-model';
    const { loadModelsFromCli, modelConfig } = await freshConfig();

    await loadModelsFromCli();

    expect(modelConfig.getModelForAgent('scaffold')).toBe('fallback-model');
    expect(modelConfig.getProviderForAgent('scaffold')).toBe('anthropic');
  });

  it('uses another available model when neither selected nor fallback models are available', async () => {
    process.env.AUTO_DEV_MODEL = 'missing-global';
    process.env.AUTO_DEV_FALLBACK_MODEL = 'missing-fallback';
    process.env.AUTO_DEV_AGENT_SCAFFOLD_MODEL = 'missing-agent';
    const { loadModelsFromCli, modelConfig } = await freshConfig();

    await loadModelsFromCli();

    expect(modelConfig.getModelForAgent('scaffold')).toBe('fast-model');
  });

  it('uses persisted UI settings before environment variables', async () => {
    process.env.AUTO_DEV_MODEL = 'anthropic:global-model';
    process.env.AUTO_DEV_FALLBACK_MODEL = 'anthropic:global-model';
    process.env.AUTO_DEV_AGENT_SCAFFOLD_MODEL = 'anthropic:global-model';
    writeFileSync(process.env.AUTO_DEV_CONFIG_PATH!, JSON.stringify({
      model: 'codex-cli:fast-model',
      fallbackModel: 'anthropic:fallback-model',
      effort: 'low',
      agentModels: { scaffold: 'anthropic:fallback-model' },
    }));
    const { loadModelsFromCli, modelConfig } = await freshConfig();

    await loadModelsFromCli();

    expect(modelConfig.getModel()).toBe('codex-cli:fast-model');
    expect(modelConfig.getModelForAgent('scaffold')).toBe('fallback-model');
    expect(modelConfig.getEffort()).toBe('low');
    expect(modelConfig.stats().fallbackModel).toBe('anthropic:fallback-model');
  });
});
