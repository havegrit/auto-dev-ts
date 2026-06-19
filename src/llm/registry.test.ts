import { describe, it, expect } from 'vitest';
import { getAgentRunner, getCompleter, getModelCatalog } from './registry.js';
import { anthropicAgentRunner } from './anthropic/agent-runner.js';
import { anthropicCompleter } from './anthropic/completer.js';
import { anthropicModelCatalog } from './anthropic/models.js';

describe('registry', () => {
  it('defaults to the anthropic implementations', () => {
    expect(getAgentRunner()).toBe(anthropicAgentRunner);
    expect(getCompleter()).toBe(anthropicCompleter);
    expect(getModelCatalog()).toBe(anthropicModelCatalog);
  });

  it('fails fast on an unknown provider', () => {
    const prev = process.env.AUTO_DEV_PROVIDER;
    process.env.AUTO_DEV_PROVIDER = 'bogus';
    try {
      expect(() => getAgentRunner()).toThrow(/Unknown provider: bogus/);
    } finally {
      if (prev === undefined) delete process.env.AUTO_DEV_PROVIDER;
      else process.env.AUTO_DEV_PROVIDER = prev;
    }
  });
});
