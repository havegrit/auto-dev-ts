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

// Event persistence hits SQLite too (agent_run_event has a FK to agent_run),
// and runs.js above is mocked so no run row exists. Mock the event layer to
// keep these dispatch tests DB-free; event persistence is covered separately.
vi.mock('./run-events.js', () => ({
  emitRunEvent: vi.fn(),
  closeEmitter: vi.fn(),
  getOrCreateEmitter: vi.fn(),
}));

// Mutable holder so each test can install its own fake runner.
let fakeRunnerImpl: {
  run: (req: unknown, onEvent: (e: AgentEvent) => void) => Promise<AgentRunOutcome>;
} = {
  run: async () => ({ status: 'success', output: '', tokensIn: 0, tokensOut: 0, numTurns: 0, stopReason: null }),
};
const getAgentRunnerMock = vi.fn((_model?: string) => fakeRunnerImpl);

vi.mock('../llm/registry.js', () => ({
  getAgentRunner: (model?: string) => getAgentRunnerMock(model),
  getCompleter: () => ({ complete: vi.fn() }),
  getModelCatalog: () => ({ listModels: vi.fn(async () => []) }),
}));

// Import runner after mocks are registered.
import { runAgent } from './runner.js';
import { circuitBreaker } from './circuit-breaker.js';
import { modelConfig } from './model-config.js';
import { insertRun, updateRun } from '../store/runs.js';
import { cancelActiveRun } from './run-cancellation.js';

describe('runAgent dispatch', () => {
  beforeEach(() => {
    getAgentRunnerMock.mockClear();
    vi.mocked(insertRun).mockClear();
    vi.mocked(updateRun).mockClear();
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

  it('preserves raw JSON output for clarifier workflow parsing', async () => {
    const rawOutput = JSON.stringify({
      ready: false,
      summary: '',
      questions: [{ id: 'q1', category: 'scope', text: '범위는?', recommendation: '핵심 CRUD' }],
    });
    fakeRunnerImpl = {
      run: async () => ({
        status: 'success',
        output: '',
        rawOutput: `${rawOutput}\n\nstderr:\nReading additional input from stdin...`,
        tokensIn: 5,
        tokensOut: 6,
        numTurns: 1,
        stopReason: 'codex_cli_exit_0',
      }),
    };

    const result = await runAgent({ name: 'clarifier', prompt: 'clarify this' });

    expect(result.output).toBe(rawOutput);
    expect(updateRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ output: rawOutput }));
  });

  it.each(['planner', 'test', 'review'])('preserves the %s workflow marker contract', async (name) => {
    let receivedReq: any;
    fakeRunnerImpl = {
      run: async (req) => {
        receivedReq = req;
        return {
          status: 'success', output: '[MARKER]', tokensIn: 1, tokensOut: 1,
          numTurns: 1, stopReason: 'end_turn',
        };
      },
    };

    await runAgent({ name, prompt: 'contract output' });

    expect(receivedReq.resultMode).toBe('raw');
  });

  it('aborts an active provider run and records CANCELLED', async () => {
    fakeRunnerImpl = {
      // Some provider iterators can remain pending while their subprocess performs graceful cleanup.
      run: async () => new Promise(() => {}),
    };

    const pending = runAgent({ name: 'scaffold', prompt: 'long task' });
    await vi.waitFor(() => expect(insertRun).toHaveBeenCalled());
    const runId = vi.mocked(insertRun).mock.calls.at(-1)![0].id;

    expect(cancelActiveRun(runId)).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: 'CANCELLED' });
    expect(updateRun).toHaveBeenCalledWith(runId, expect.objectContaining({
      status: 'FAILED',
      errorType: 'user_cancelled',
    }));
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

  it('persists token usage while provider run is still active', async () => {
    fakeRunnerImpl = {
      run: async (_req, onEvent) => {
        onEvent({ kind: 'usage', tokensIn: 120, tokensOut: 30 });
        return { status: 'success', output: 'ok', tokensIn: 120, tokensOut: 30, numTurns: 1, stopReason: 'end_turn' };
      },
    };

    await runAgent({ name: 'scaffold', prompt: 'build' });

    expect(updateRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      tokensIn: 120,
      tokensOut: 30,
      durationMs: expect.any(Number),
    }));
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

  it('records a subscription failure returned as success as FAILED', async () => {
    const getFallbackModel = vi.spyOn(modelConfig, 'getFallbackModel').mockReturnValue(undefined);
    fakeRunnerImpl = {
      run: async () => ({
        status: 'success',
        output: 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access',
        tokensIn: 0,
        tokensOut: 0,
        numTurns: 1,
        stopReason: 'stop_sequence',
      }),
    };

    const result = await runAgent({ name: 'clarifier', prompt: 'clarify this' });

    expect(result.status).toBe('FAILED');
    expect(updateRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: 'FAILED',
      errorType: 'anthropic_auth_failed',
      stopReason: 'authentication_required',
    }));
    getFallbackModel.mockRestore();
  });

  it('passes the agent-specific resolved model to the provider runner', async () => {
    let receivedReq: any;
    const getModelIdForAgent = vi.spyOn(modelConfig, 'getModelIdForAgent').mockReturnValue('codex-cli:agent-model');
    const getModelForAgent = vi.spyOn(modelConfig, 'getModelForAgent').mockReturnValue('agent-model');
    const getEffortOptionForAgent = vi.spyOn(modelConfig, 'getEffortOptionForAgent').mockReturnValue('medium');
    fakeRunnerImpl = {
      run: async (req, _onEvent) => {
        receivedReq = req;
        return { status: 'success', output: 'ok', tokensIn: 1, tokensOut: 1, numTurns: 1, stopReason: 'end_turn' };
      },
    };

    await runAgent({ name: 'scaffold', prompt: 'build it' });

    expect(getModelIdForAgent).toHaveBeenCalledWith('scaffold');
    expect(getAgentRunnerMock).toHaveBeenCalledWith('codex-cli:agent-model');
    expect(getModelForAgent).toHaveBeenCalledWith('scaffold');
    expect(getEffortOptionForAgent).toHaveBeenCalledWith('scaffold');
    expect(receivedReq.model).toBe('agent-model');
    expect(receivedReq.effort).toBe('medium');
    expect(receivedReq.resultMode).toBe('generic');
    expect(insertRun).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'codex-cli:agent-model' }));
    expect(updateRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ modelId: 'codex-cli:agent-model' }));
    getModelIdForAgent.mockRestore();
    getModelForAgent.mockRestore();
    getEffortOptionForAgent.mockRestore();
  });

  it('retries once with the fallback model when the primary model hits a rate limit', async () => {
    const requests: any[] = [];
    const getModelIdForAgent = vi.spyOn(modelConfig, 'getModelIdForAgent').mockReturnValue('anthropic:opus');
    const getModelForAgent = vi.spyOn(modelConfig, 'getModelForAgent').mockReturnValue('opus');
    const getEffortOptionForAgent = vi.spyOn(modelConfig, 'getEffortOptionForAgent').mockReturnValue('xhigh');
    const getFallbackModel = vi.spyOn(modelConfig, 'getFallbackModel').mockReturnValue('codex-cli:gpt-5.5');
    const getModelForModelId = vi.spyOn(modelConfig, 'getModelForModelId').mockReturnValue('gpt-5.5');
    const getEffortOptionForModelId = vi.spyOn(modelConfig, 'getEffortOptionForModelId').mockReturnValue('xhigh');
    fakeRunnerImpl = {
      run: async (req, onEvent) => {
        requests.push(req);
        if (requests.length === 1) {
          onEvent({ kind: 'rate_limit', resetsAt: Date.now() + 60_000 });
          return { status: 'success', output: 'limit', tokensIn: 0, tokensOut: 0, numTurns: 1, stopReason: 'stop_sequence' };
        }
        return { status: 'success', output: 'fallback ok', tokensIn: 1, tokensOut: 1, numTurns: 1, stopReason: 'end_turn' };
      },
    };

    const result = await runAgent({ name: 'clarifier', prompt: 'p' });

    expect(result.output).toBe('fallback ok');
    expect(getAgentRunnerMock).toHaveBeenNthCalledWith(1, 'anthropic:opus');
    expect(getAgentRunnerMock).toHaveBeenNthCalledWith(2, 'codex-cli:gpt-5.5');
    expect(requests.map(r => r.model)).toEqual(['opus', 'gpt-5.5']);
    expect(requests.map(r => r.resultMode)).toEqual(['raw', 'raw']);
    expect(updateRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ modelId: 'codex-cli:gpt-5.5' }));
    expect(circuitBreaker.isOpen()).toBe(false);
    getModelIdForAgent.mockRestore();
    getModelForAgent.mockRestore();
    getEffortOptionForAgent.mockRestore();
    getFallbackModel.mockRestore();
    getModelForModelId.mockRestore();
    getEffortOptionForModelId.mockRestore();
  });

  it('retries once with the fallback model when the primary model has an auth failure', async () => {
    const requests: any[] = [];
    const getModelIdForAgent = vi.spyOn(modelConfig, 'getModelIdForAgent').mockReturnValue('anthropic:sonnet');
    const getModelForAgent = vi.spyOn(modelConfig, 'getModelForAgent').mockReturnValue('sonnet');
    const getEffortOptionForAgent = vi.spyOn(modelConfig, 'getEffortOptionForAgent').mockReturnValue('high');
    const getFallbackModel = vi.spyOn(modelConfig, 'getFallbackModel').mockReturnValue('codex-cli:gpt-5.5');
    const getModelForModelId = vi.spyOn(modelConfig, 'getModelForModelId').mockReturnValue('gpt-5.5');
    const getEffortOptionForModelId = vi.spyOn(modelConfig, 'getEffortOptionForModelId').mockReturnValue('high');
    fakeRunnerImpl = {
      run: async (req) => {
        requests.push(req);
        if (requests.length === 1) {
          return {
            status: 'error', output: 'subscription disabled', errorType: 'anthropic_auth_failed',
            tokensIn: 0, tokensOut: 0, numTurns: 1, stopReason: 'stop_sequence',
          };
        }
        return {
          status: 'success', output: '[TESTS: PASS]', tokensIn: 1, tokensOut: 1,
          numTurns: 1, stopReason: 'end_turn',
        };
      },
    };

    const result = await runAgent({ name: 'test', prompt: 'verify it' });

    expect(result).toMatchObject({ status: 'DONE', output: '[TESTS: PASS]' });
    expect(getAgentRunnerMock).toHaveBeenNthCalledWith(1, 'anthropic:sonnet');
    expect(getAgentRunnerMock).toHaveBeenNthCalledWith(2, 'codex-cli:gpt-5.5');
    expect(requests.map(r => r.resultMode)).toEqual(['raw', 'raw']);
    expect(updateRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ modelId: 'codex-cli:gpt-5.5' }));
    getModelIdForAgent.mockRestore();
    getModelForAgent.mockRestore();
    getEffortOptionForAgent.mockRestore();
    getFallbackModel.mockRestore();
    getModelForModelId.mockRestore();
    getEffortOptionForModelId.mockRestore();
  });
});
