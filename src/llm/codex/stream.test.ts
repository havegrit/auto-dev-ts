import { describe, expect, it } from 'vitest';
import { newCodexStreamState, foldCodexLine, resultText } from './stream.js';
import type { AgentEvent } from '../types.js';

function run(lines: string[]) {
  const state = newCodexStreamState();
  const events: AgentEvent[] = [];
  for (const line of lines) events.push(...foldCodexLine(line, state));
  return { state, events };
}

describe('codex stream parser', () => {
  it('emits text for agent_message items as they complete', () => {
    const { events } = run([
      '{"type":"thread.started","thread_id":"x"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"읽는 중입니다"}}',
    ]);
    expect(events).toEqual([{ kind: 'text', text: '읽는 중입니다' }]);
  });

  it('shows the contract summary live instead of the raw JSON blob', () => {
    const { events } = run([
      '{"type":"item.completed","item":{"id":"i9","type":"agent_message","text":"{\\"status\\":\\"success\\",\\"summary\\":\\"작업 완료\\"}"}}',
    ]);
    expect(events).toEqual([{ kind: 'text', text: '작업 완료' }]);
  });

  it('emits tool_call and tool_result for command_execution', () => {
    const { events } = run([
      '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"npm test","aggregated_output":"all passed","exit_code":0}}',
    ]);
    expect(events).toEqual([
      { kind: 'tool_call', name: 'shell', input: 'npm test' },
      { kind: 'tool_result', content: '[exit 0] all passed' },
    ]);
  });

  it('emits tool_call for file_change items', () => {
    const { events } = run([
      '{"type":"item.completed","item":{"id":"i2","type":"file_change","changes":[{"path":"src/a.ts","kind":"modified"},{"path":"src/b.ts","kind":"added"}]}}',
    ]);
    expect(events).toEqual([{ kind: 'tool_call', name: 'edit', input: 'src/a.ts, src/b.ts' }]);
  });

  it('accumulates and emits token usage from turn.completed', () => {
    const { state, events } = run([
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}',
      '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":3}}',
    ]);
    expect(state.tokensIn).toBe(105);
    expect(state.tokensOut).toBe(23);
    expect(events).toEqual([
      { kind: 'usage', tokensIn: 100, tokensOut: 20 },
      { kind: 'usage', tokensIn: 105, tokensOut: 23 },
    ]);
  });

  it('tracks the last agent_message as the result text', () => {
    const { state } = run([
      '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"final"}}',
    ]);
    expect(resultText(state)).toBe('final');
  });

  it('ignores malformed or unknown lines without throwing', () => {
    const { events, state } = run([
      'not json',
      '',
      '{"type":"some.unknown.event"}',
    ]);
    expect(events).toEqual([]);
    expect(resultText(state)).toBe('');
  });
});
