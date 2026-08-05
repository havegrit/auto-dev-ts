import { describe, it, expect } from 'vitest';
import { reduceMessage, newAccumulator } from './message-reducer.js';
import type { AgentEvent } from '../types.js';

function collect(msgs: any[]) {
  const events: AgentEvent[] = [];
  const acc = newAccumulator();
  let outcome = null;
  for (const m of msgs) {
    const r = reduceMessage(m, acc, (e) => events.push(e));
    if (r) outcome = r;
  }
  return { events, outcome, acc };
}

describe('reduceMessage', () => {
  it('emits text and tool_call from an assistant message', () => {
    const { events } = collect([
      { type: 'assistant', message: { content: [
        { type: 'text', text: '  hello  ' },
        { type: 'tool_use', name: 'Read', input: { path: 'a.ts' } },
      ] } },
    ]);
    expect(events).toEqual([
      { kind: 'text', text: 'hello' },
      { kind: 'tool_call', name: 'Read', input: '{"path":"a.ts"}' },
    ]);
  });

  it('skips empty text blocks', () => {
    const { events } = collect([
      { type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } },
    ]);
    expect(events).toEqual([]);
  });

  it('emits tool_result content from a user message (real SDK shape)', () => {
    const { events } = collect([
      { type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'file body' }] },
      ] } },
    ]);
    expect(events).toEqual([{ kind: 'tool_result', content: 'file body' }]);
  });

  it('emits tool_result when content is a plain string', () => {
    const { events } = collect([
      { type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'plain body' },
      ] } },
    ]);
    expect(events).toEqual([{ kind: 'tool_result', content: 'plain body' }]);
  });

  it('ignores user messages that carry no tool_result blocks', () => {
    const { events } = collect([
      { type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]);
    expect(events).toEqual([]);
  });

  it('maps a rejected rate_limit_event with resetsAt', () => {
    const { events } = collect([
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1234 } },
    ]);
    expect(events).toEqual([{ kind: 'rate_limit', resetsAt: 1234 }]);
  });

  it('maps a rejected rate_limit_event without resetsAt to a bare rate_limit', () => {
    const { events } = collect([
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } },
    ]);
    expect(events).toEqual([{ kind: 'rate_limit' }]);
  });

  it('maps a 429 api_retry with retry_delay_ms', () => {
    const { events } = collect([
      { type: 'system', subtype: 'api_retry', error_status: 429, retry_delay_ms: 500 },
    ]);
    expect(events).toEqual([{ kind: 'rate_limit', retryDelayMs: 500 }]);
  });

  it('returns a success outcome on result success', () => {
    const { outcome } = collect([
      { type: 'result', subtype: 'success', result: 'done', num_turns: 3,
        stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } },
    ]);
    expect(outcome).toEqual({
      status: 'success', output: 'done', tokensIn: 10, tokensOut: 20,
      numTurns: 3, stopReason: 'end_turn',
    });
  });

  it('maps the Claude login prompt to an auth error even when the SDK reports success', () => {
    const { outcome } = collect([
      { type: 'result', subtype: 'success', result: 'Not logged in · Please run /login',
        num_turns: 1, stop_reason: 'stop_sequence', usage: { input_tokens: 0, output_tokens: 0 } },
    ]);

    expect(outcome).toEqual({
      status: 'error',
      errorType: 'anthropic_auth_failed',
      output: 'Not logged in · Please run /login',
      tokensIn: 0,
      tokensOut: 0,
      numTurns: 1,
      stopReason: 'stop_sequence',
      permissionDenials: [],
      errors: ['Not logged in · Please run /login'],
    });
  });

  it('maps disabled organization subscription access to an auth error', () => {
    const output = 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';
    const { outcome } = collect([
      { type: 'result', subtype: 'success', result: output,
        num_turns: 1, stop_reason: 'stop_sequence', usage: { input_tokens: 0, output_tokens: 0 } },
    ]);

    expect(outcome).toMatchObject({
      status: 'error',
      errorType: 'anthropic_auth_failed',
      output,
      tokensIn: 0,
      tokensOut: 0,
    });
  });

  it('does not mistake normal output discussing /login for an auth failure', () => {
    const output = 'Update the login page and document that users may run /login.';
    const { outcome } = collect([
      { type: 'result', subtype: 'success', result: output, usage: {} },
    ]);

    expect(outcome).toMatchObject({ status: 'success', output });
  });

  it('returns an error outcome on result error with denials', () => {
    const { outcome } = collect([
      { type: 'result', subtype: 'error_max_turns', errors: ['boom'],
        permission_denials: [{ tool_name: 'Bash' }],
        num_turns: 5, stop_reason: null, usage: { input_tokens: 1, output_tokens: 2 } },
    ]);
    expect(outcome).toEqual({
      status: 'error', errorType: 'error_max_turns',
      output: '[error_max_turns]\nboom\nPermission denied: Bash',
      tokensIn: 1, tokensOut: 2, numTurns: 5, stopReason: null,
      permissionDenials: ['Bash'],
      errors: ['boom'],
    });
  });

  it('returns null for non-terminal messages', () => {
    const acc = newAccumulator();
    expect(reduceMessage({ type: 'assistant', message: { content: [] } }, acc, () => {})).toBeNull();
  });
});
