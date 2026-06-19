import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (...a: any[]) => queryMock(...a) }));

import { anthropicCompleter } from './completer.js';

function asyncGen(msgs: any[]) {
  return (async function* () { for (const m of msgs) yield m; })();
}

beforeEach(() => queryMock.mockReset());

describe('anthropicCompleter', () => {
  it('returns the result text on success', async () => {
    queryMock.mockReturnValue(asyncGen([{ type: 'result', subtype: 'success', result: 'hello' }]));
    const out = await anthropicCompleter.complete({ message: 'hi' });
    expect(out).toBe('hello');
  });

  it('appends a JSON-only instruction to the system prompt when json is set', async () => {
    queryMock.mockReturnValue(asyncGen([{ type: 'result', subtype: 'success', result: '{}' }]));
    await anthropicCompleter.complete({ system: 'base', message: 'hi', json: true });
    const opts = queryMock.mock.calls[0][0].options;
    expect(opts.systemPrompt).toContain('base');
    expect(opts.systemPrompt).toContain('JSON');
  });

  it('throws on a failed completion', async () => {
    queryMock.mockReturnValue(asyncGen([{ type: 'result', subtype: 'error_during_execution' }]));
    await expect(anthropicCompleter.complete({ message: 'hi' })).rejects.toThrow(/completion failed/);
  });
});
