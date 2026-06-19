import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (...a: any[]) => queryMock(...a) }));

import { anthropicAgentRunner } from './agent-runner.js';
import type { AgentEvent } from '../types.js';

function asyncGen(msgs: any[]) {
  return (async function* () { for (const m of msgs) yield m; })();
}

const req = { prompt: 'p', cwd: '/tmp', tools: ['Read'], model: 'claude-opus-4-8', effort: 'high' };

beforeEach(() => queryMock.mockReset());

describe('anthropicAgentRunner', () => {
  it('passes tools/model/effort to query and returns the success outcome', async () => {
    queryMock.mockReturnValue(asyncGen([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'result', subtype: 'success', result: 'ok', num_turns: 1, stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 6 } },
    ]));
    const events: AgentEvent[] = [];
    const outcome = await anthropicAgentRunner.run(req, (e) => events.push(e));

    expect(queryMock).toHaveBeenCalledOnce();
    const opts = queryMock.mock.calls[0][0].options;
    expect(opts.allowedTools).toEqual(['Read']);
    expect(opts.model).toBe('claude-opus-4-8');
    expect(opts.effort).toBe('high');
    expect(events).toContainEqual({ kind: 'text', text: 'hi' });
    expect(outcome).toMatchObject({ status: 'success', output: 'ok', tokensIn: 5, tokensOut: 6 });
  });

  it('adds the Agent tool when subagents are present', async () => {
    queryMock.mockReturnValue(asyncGen([
      { type: 'result', subtype: 'success', result: '', usage: {} },
    ]));
    await anthropicAgentRunner.run({ ...req, subagents: { lens: {} } }, () => {});
    const opts = queryMock.mock.calls[0][0].options;
    expect(opts.allowedTools).toEqual(['Read', 'Agent']);
    expect(opts.agents).toEqual({ lens: {} });
  });

  it('returns a no_result error outcome when the stream ends without a result', async () => {
    queryMock.mockReturnValue(asyncGen([
      { type: 'assistant', message: { content: [] } },
    ]));
    const outcome = await anthropicAgentRunner.run(req, () => {});
    expect(outcome).toMatchObject({ status: 'error', errorType: 'no_result' });
  });
});
