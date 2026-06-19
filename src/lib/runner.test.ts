import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentRunOutcome, AgentEvent } from '../llm/types.js';

// Silence the pino logger so test output stays pristine.
vi.mock('./logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock the store so no SQLite file is opened at all.
vi.mock('../store/runs.js', () => ({
  insertRun: vi.fn(),
  updateRun: vi.fn(),
  getRun: vi.fn(),
  getRecentRuns: vi.fn(() => []),
  getRunsByWorkflowId: vi.fn(() => []),
  getStats: vi.fn(() => ({})),
}));

// Mutable holder so each test can install its own fake runner.
let fakeRunnerImpl: {
  run: (req: unknown, onEvent: (e: AgentEvent) => void) => Promise<AgentRunOutcome>;
} = {
  run: async () => ({ status: 'success', output: '', tokensIn: 0, tokensOut: 0, numTurns: 0, stopReason: null }),
};

vi.mock('../llm/registry.js', () => ({
  getAgentRunner: () => fakeRunnerImpl,
  getCompleter: () => ({ complete: vi.fn() }),
  getModelCatalog: () => ({ listModels: vi.fn(async () => []) }),
}));

// Import runner after mocks are registered.
import { runAgent } from './runner.js';
import { circuitBreaker } from './circuit-breaker.js';

describe('runAgent dispatch', () => {
  beforeEach(() => {
    circuitBreaker.reset();
  });

  afterEach(() => {
    circuitBreaker.reset();
  });

  it('SUCCESS: returns RunResult with output and token counts from fake runner', async () => {
    fakeRunnerImpl = {
      run: async (_req, _onEvent) => ({
        status: 'success',
        output: 'ok',
        tokensIn: 5,
        tokensOut: 6,
        numTurns: 1,
        stopReason: 'end_turn',
      }),
    };

    const result = await runAgent({ name: 'test-agent', prompt: 'do something' });

    expect(result.output).toBe('ok');
    expect(result.tokensIn).toBe(5);
    expect(result.tokensOut).toBe(6);
  });

  it('RATE_LIMIT: onEvent rate_limit opens circuit breaker', async () => {
    const farFuture = Date.now() + 60_000;
    fakeRunnerImpl = {
      run: async (_req, onEvent) => {
        onEvent({ kind: 'rate_limit', resetsAt: farFuture });
        return { status: 'success', output: 'ok', tokensIn: 1, tokensOut: 1, numTurns: 1, stopReason: 'end_turn' };
      },
    };

    await runAgent({ name: 'test-agent', prompt: 'trigger rate limit' });

    expect(circuitBreaker.isOpen()).toBe(true);
  });

  it('ERROR: fake returns error outcome — runAgent resolves (does not throw)', async () => {
    fakeRunnerImpl = {
      run: async (_req, _onEvent) => ({
        status: 'error',
        output: '[error_max_turns]',
        errorType: 'error_max_turns',
        tokensIn: 2,
        tokensOut: 3,
        numTurns: 10,
        stopReason: null,
      }),
    };

    const result = await runAgent({ name: 'test-agent', prompt: 'run too long' });

    expect(result.output).toBe('[error_max_turns]');
    expect(result.tokensIn).toBe(2);
    expect(result.tokensOut).toBe(3);
  });
});
