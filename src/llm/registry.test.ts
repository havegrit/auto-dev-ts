import { describe, it, expect } from 'vitest';
import { getAgentRunner, getCompleter } from './registry.js';
import { anthropicAgentRunner } from './anthropic/agent-runner.js';
import { anthropicCompleter } from './anthropic/completer.js';
import { codexAgentRunner } from './codex/agent-runner.js';
import { codexCompleter } from './codex/completer.js';

describe('registry', () => {
  it('defaults to the anthropic implementations', () => {
    expect(getAgentRunner()).toBe(anthropicAgentRunner);
    expect(getCompleter()).toBe(anthropicCompleter);
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

  it('selects the Codex CLI implementations by provider name', () => {
    const prev = process.env.AUTO_DEV_PROVIDER;
    process.env.AUTO_DEV_PROVIDER = 'codex-cli';
    try {
      expect(getAgentRunner()).toBe(codexAgentRunner);
      expect(getCompleter()).toBe(codexCompleter);
    } finally {
      if (prev === undefined) delete process.env.AUTO_DEV_PROVIDER;
      else process.env.AUTO_DEV_PROVIDER = prev;
    }
  });

  it('selects provider implementations from qualified model ids', () => {
    expect(getAgentRunner('anthropic:default')).toBe(anthropicAgentRunner);
    expect(getCompleter('anthropic:default')).toBe(anthropicCompleter);
    expect(getAgentRunner('codex-cli:gpt-5')).toBe(codexAgentRunner);
    expect(getCompleter('codex-cli:gpt-5')).toBe(codexCompleter);
  });

  it('fails fast when a qualified model uses an unknown provider', () => {
    expect(() => getAgentRunner('openai:gpt-5')).toThrow(/Unknown provider: openai/);
  });
});
