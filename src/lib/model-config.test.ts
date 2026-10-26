import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const listedModels = vi.hoisted(() => ({
  value: [
    { id: 'codex-cli:fast-model', provider: 'codex-cli', providerModel: 'fast-model', displayName: 'Fast Model', effortLevels: ['low', 'high'] },
    { id: 'anthropic:fallback-model', provider: 'anthropic', providerModel: 'fallback-model', displayName: 'Fallback Model', effortLevels: ['low', 'medium', 'high'] },
    { id: 'anthropic:global-model', provider: 'anthropic', providerModel: 'global-model', displayName: 'Global Model', effortLevels: ['high'] },
  ],
  unavailableProviders: [] as string[],
}));

vi.mock('./logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../llm/registry.js', () => ({
  getProviderModelCatalogs: vi.fn(async () => Object.fromEntries(
    ['anthropic', 'codex-cli', 'openai-compatible'].map(provider => [provider, {
      models: listedModels.value.filter(model => model.provider === provider),
      authoritative: !listedModels.unavailableProviders.includes(provider),
      ...(!listedModels.unavailableProviders.includes(provider) ? {} : { error: 'offline' }),
    }]),
  )),
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
      { id: 'openai-compatible:deepseek-v4', provider: 'openai-compatible', providerModel: 'deepseek-v4', displayName: 'OpenAI Compatible', effortLevels: ['low', 'medium'] },
    ];
    listedModels.unavailableProviders = [];
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

  it('skips openai-compatible models for agent runs and falls back to an agent-capable model', async () => {
    process.env.AUTO_DEV_MODEL = 'openai-compatible:deepseek-v4';
    process.env.AUTO_DEV_FALLBACK_MODEL = 'anthropic:fallback-model';
    process.env.AUTO_DEV_AGENT_SCAFFOLD_MODEL = 'openai-compatible:deepseek-v4';
    const { loadModelsFromCli, modelConfig } = await freshConfig();

    await loadModelsFromCli();

    expect(modelConfig.getProviderForAgent('scaffold')).toBe('anthropic');
    expect(modelConfig.getModelForAgent('scaffold')).toBe('fallback-model');
  });

  it('uses another available model when neither selected nor fallback models are available', async () => {
    process.env.AUTO_DEV_MODEL = 'missing-global';
    process.env.AUTO_DEV_FALLBACK_MODEL = 'missing-fallback';
    process.env.AUTO_DEV_AGENT_SCAFFOLD_MODEL = 'missing-agent';
    const { loadModelsFromCli, modelConfig } = await freshConfig();

    await loadModelsFromCli();

    expect(modelConfig.getModelForAgent('scaffold')).toBe('fallback-model');
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

  it('uses an explicit agent effort and leaves unset effort to the provider', async () => {
    writeFileSync(process.env.AUTO_DEV_CONFIG_PATH!, JSON.stringify({
      model: 'anthropic:global-model',
      agentModels: { scaffold: 'codex-cli:fast-model' },
      agentEfforts: { scaffold: 'low' },
    }));
    const { loadModelsFromCli, modelConfig } = await freshConfig();

    await loadModelsFromCli();

    expect(modelConfig.getEffortOptionForAgent('scaffold')).toBe('low');
    expect(modelConfig.getEffortOptionForAgent('planner')).toBeUndefined();
    expect(modelConfig.stats().agentEfforts).toEqual({ scaffold: 'low' });
  });

  it('removes retired models and incompatible saved agent effort settings', async () => {
    listedModels.value = [
      { id: 'anthropic:global-model', provider: 'anthropic', providerModel: 'global-model', displayName: 'Global Model', effortLevels: ['high'] },
      { id: 'codex-cli:fast-model', provider: 'codex-cli', providerModel: 'fast-model', displayName: 'Fast Model', effortLevels: ['low', 'high'] },
    ];
    writeFileSync(process.env.AUTO_DEV_CONFIG_PATH!, JSON.stringify({
      model: 'codex-cli:retired-model',
      fallbackModel: 'codex-cli:retired-model',
      effort: 'low',
      agentModels: { scaffold: 'codex-cli:retired-model' },
      agentEfforts: { scaffold: 'medium' },
    }));
    const { loadModelsFromCli, modelConfig } = await freshConfig();

    await loadModelsFromCli();

    const config = JSON.parse(readFileSync(process.env.AUTO_DEV_CONFIG_PATH!, 'utf8'));
    expect(modelConfig.stats().availableModels.map(model => model.id)).not.toContain('codex-cli:retired-model');
    expect(modelConfig.getFallbackModel()).toBeUndefined();
    expect(modelConfig.getModel()).toBe('anthropic:global-model');
    expect(config).not.toHaveProperty('fallbackModel');
    expect(config).not.toHaveProperty('agentModels');
    expect(config).not.toHaveProperty('agentEfforts');
  });

  it('keeps a provider catalog unchanged when that provider refresh fails', async () => {
    const { loadModelsFromCli, modelConfig } = await freshConfig();
    await loadModelsFromCli();
    listedModels.value = listedModels.value.filter(model => model.provider !== 'codex-cli');
    listedModels.unavailableProviders = ['codex-cli'];

    await loadModelsFromCli();

    expect(modelConfig.stats().availableModels.map(model => model.id)).toContain('codex-cli:fast-model');
  });

  it('preserves configured provider models on startup outage, then removes them after a successful refresh', async () => {
    listedModels.unavailableProviders = ['codex-cli'];
    writeFileSync(process.env.AUTO_DEV_CONFIG_PATH!, JSON.stringify({
      model: 'codex-cli:custom-model',
      fallbackModel: 'codex-cli:custom-model',
      agentModels: { scaffold: 'codex-cli:custom-model' },
      agentEfforts: { scaffold: 'high' },
    }));
    const { loadModelsFromCli, modelConfig } = await freshConfig();

    await loadModelsFromCli();
    expect(modelConfig.getModel()).toBe('codex-cli:custom-model');
    expect(modelConfig.getFallbackModel()).toBe('codex-cli:custom-model');
    expect(modelConfig.getEffortOptionForAgent('scaffold')).toBe('high');

    listedModels.unavailableProviders = [];
    await loadModelsFromCli();

    expect(modelConfig.stats().availableModels.map(model => model.id)).not.toContain('codex-cli:custom-model');
    expect(modelConfig.getModel()).not.toBe('codex-cli:custom-model');
    expect(modelConfig.getFallbackModel()).toBeUndefined();
  });

  it('persists agent effort overrides and validates them against each effective model', async () => {
    const { loadModelsFromCli, modelConfig } = await freshConfig();
    await loadModelsFromCli();
    modelConfig.set('anthropic:global-model', 'high', {
      agentModels: { scaffold: 'codex-cli:fast-model' },
      agentEfforts: { scaffold: 'low' },
      persist: true,
    });

    expect(modelConfig.getEffortOptionForAgent('scaffold')).toBe('low');
    expect(JSON.parse(readFileSync(process.env.AUTO_DEV_CONFIG_PATH!, 'utf8')).agentEfforts).toEqual({ scaffold: 'low' });
    expect(() => modelConfig.set('anthropic:global-model', 'high', {
      agentModels: { scaffold: 'codex-cli:fast-model' },
      agentEfforts: { scaffold: 'medium' },
    })).toThrow('Model codex-cli:fast-model does not support effort level: medium');
  });

  it('keeps model overrides isolated to concurrent async runs', async () => {
    const { loadModelsFromCli, modelConfig, withAgentModelOverrides } = await freshConfig();
    await loadModelsFromCli();

    const [fallbackRun, globalRun] = await Promise.all([
      withAgentModelOverrides({ scaffold: 'anthropic:fallback-model' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return modelConfig.getModelIdForAgent('scaffold');
      }),
      withAgentModelOverrides({ scaffold: 'anthropic:global-model' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return modelConfig.getModelIdForAgent('scaffold');
      }),
    ]);

    expect(fallbackRun).toBe('anthropic:fallback-model');
    expect(globalRun).toBe('anthropic:global-model');
    expect(modelConfig.getModelIdForAgent('scaffold')).toBe('anthropic:fallback-model');
    expect(modelConfig.hasRunnableModel('openai-compatible:deepseek-v4')).toBe(false);
  });
});
