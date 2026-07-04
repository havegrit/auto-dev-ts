import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openaiModelCatalog } from './models.js';

const ENV = { ...process.env };

beforeEach(() => {
  delete process.env.AUTO_DEV_OPENAI_API_KEY;
  delete process.env.AUTO_DEV_OPENAI_MODELS;
});

afterEach(() => {
  process.env = { ...ENV };
});

describe('openaiModelCatalog', () => {
  it('lists the models named in AUTO_DEV_OPENAI_MODELS', async () => {
    process.env.AUTO_DEV_OPENAI_API_KEY = 'k';
    process.env.AUTO_DEV_OPENAI_MODELS = 'deepseek-ai/deepseek-v4-pro, meta/llama-3.1-70b';
    const models = await openaiModelCatalog.listModels();
    expect(models.map(m => m.id)).toEqual(['deepseek-ai/deepseek-v4-pro', 'meta/llama-3.1-70b']);
  });

  it('returns nothing when the provider is unconfigured (no api key)', async () => {
    process.env.AUTO_DEV_OPENAI_MODELS = 'deepseek-ai/deepseek-v4-pro';
    const models = await openaiModelCatalog.listModels();
    expect(models).toEqual([]);
  });

  it('returns nothing when no models are named', async () => {
    process.env.AUTO_DEV_OPENAI_API_KEY = 'k';
    const models = await openaiModelCatalog.listModels();
    expect(models).toEqual([]);
  });
});
