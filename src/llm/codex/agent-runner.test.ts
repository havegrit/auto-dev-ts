import { describe, expect, it } from 'vitest';
import { createCodexAgentRunner } from './agent-runner.js';
import type { AgentEvent } from '../types.js';

/** JSONL 라인들을 onStdoutLine 으로 흘려보내는 가짜 스트리밍 실행기. */
function fakeExec(lines: string[], result: { exitCode?: number; stderr?: string } = {}) {
  const calls: any[] = [];
  const exec = async (cmd: string, args: string[], options: any, onLine: (l: string) => void) => {
    calls.push({ cmd, args, options });
    for (const line of lines) onLine(line);
    const stdout = lines.join('\n') + '\n';
    return { exitCode: result.exitCode ?? 0, stdout, stderr: result.stderr ?? '' };
  };
  return { exec, calls };
}

describe('codexAgentRunner', () => {
  it('streams events live and merges git changed files', async () => {
    const prevCommand = process.env.AUTO_DEV_CODEX_COMMAND;
    const prevSandbox = process.env.AUTO_DEV_CODEX_SANDBOX;
    delete process.env.AUTO_DEV_CODEX_COMMAND;
    delete process.env.AUTO_DEV_CODEX_SANDBOX;
    try {
      const { exec, calls } = fakeExec([
      '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"작업 시작"}}',
      '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"npm test","aggregated_output":"ok","exit_code":0}}',
      '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"{\\"status\\":\\"success\\",\\"summary\\":\\"done\\",\\"changedFiles\\":[\\"src/model.ts\\"],\\"notes\\":[]}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":900,"output_tokens":120}}',
      ]);
      const runner = createCodexAgentRunner({
        exec,
        collectChangedFiles: async () => ['src/model.ts', 'src/actual.ts'],
      });
      const events: AgentEvent[] = [];

      const outcome = await runner.run(
        { prompt: 'implement feature', cwd: '/repo', tools: ['Read', 'Write'], model: 'gpt-5', effort: 'high' },
        (event) => events.push(event),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe('codex');
      expect(calls[0].args.slice(0, 4)).toEqual(['exec', '--json', '--cd', '/repo']);
      expect(calls[0].args).not.toContain('--sandbox');
      expect(calls[0].args).toContain('--model');
      expect(calls[0].args.at(-1)).toContain('implement feature');
      expect(calls[0].args.at(-1)).toContain('"changedFiles"');

      // 실행 도중 단계별로 라이브 이벤트가 흘러나온다
      expect(events).toContainEqual({ kind: 'text', text: '작업 시작' });
      expect(events).toContainEqual({ kind: 'tool_call', name: 'shell', input: 'npm test' });
      expect(events).toContainEqual({ kind: 'text', text: 'done' }); // 계약 JSON 대신 summary

      expect(outcome).toMatchObject({
        status: 'success',
        changedFiles: ['src/model.ts', 'src/actual.ts'],
        tokensIn: 900,
        tokensOut: 120,
      });
      expect(outcome.output).toContain('done');
      expect(outcome.output).not.toContain('"status"');
    } finally {
      if (prevCommand === undefined) delete process.env.AUTO_DEV_CODEX_COMMAND;
      else process.env.AUTO_DEV_CODEX_COMMAND = prevCommand;
      if (prevSandbox === undefined) delete process.env.AUTO_DEV_CODEX_SANDBOX;
      else process.env.AUTO_DEV_CODEX_SANDBOX = prevSandbox;
    }
  });

  it('passes an explicit sandbox mode through to Codex CLI', async () => {
    const prevSandbox = process.env.AUTO_DEV_CODEX_SANDBOX;
    process.env.AUTO_DEV_CODEX_SANDBOX = 'workspace-write';
    try {
      const { exec, calls } = fakeExec(['{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"ok"}}']);
      const runner = createCodexAgentRunner({ exec, collectChangedFiles: async () => [] });

      await runner.run(
        { prompt: 'p', cwd: '/repo', tools: [], model: 'gpt-5' },
        () => {},
      );

      expect(calls[0].args).toContain('--sandbox');
      expect(calls[0].args).toContain('workspace-write');
    } finally {
      if (prevSandbox === undefined) delete process.env.AUTO_DEV_CODEX_SANDBOX;
      else process.env.AUTO_DEV_CODEX_SANDBOX = prevSandbox;
    }
  });

  it('does not append the generic result contract in raw result mode', async () => {
    const response = JSON.stringify({ ready: false, summary: '', questions: [] });
    const { exec, calls } = fakeExec([
      JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: response } }),
    ]);
    const runner = createCodexAgentRunner({ exec, collectChangedFiles: async () => [] });

    const outcome = await runner.run(
      { prompt: 'clarifier contract only', cwd: '/repo', tools: ['Read'], model: 'gpt-5', resultMode: 'raw' },
      () => {},
    );

    expect(calls[0].args.at(-1)).toBe('clarifier contract only');
    expect(calls[0].args.at(-1)).not.toContain('changedFiles');
    expect(outcome.rawOutput).toBe(response);
  });

  it('passes the cancellation signal to the Codex subprocess', async () => {
    const { exec, calls } = fakeExec([]);
    const runner = createCodexAgentRunner({ exec, collectChangedFiles: async () => [] });
    const abortController = new AbortController();

    await runner.run(
      { prompt: 'p', cwd: '/repo', tools: [], model: 'gpt-5', abortController },
      () => {},
    );

    expect(calls[0].options.signal).toBe(abortController.signal);
  });

  it('maps codex process failures to an error outcome instead of throwing', async () => {
    const { exec } = fakeExec([], { exitCode: 124, stderr: 'timed out' });
    const runner = createCodexAgentRunner({ exec, collectChangedFiles: async () => [] });

    const outcome = await runner.run(
      { prompt: 'p', cwd: '/repo', tools: [], model: 'gpt-5' },
      () => {},
    );

    expect(outcome).toMatchObject({
      status: 'error',
      errorType: 'codex_cli_exit_124',
      errors: ['timed out'],
    });
  });

  it('accepts a complete success contract emitted before process timeout', async () => {
    const response = JSON.stringify({
      status: 'success', summary: 'implemented', changedFiles: ['src/a.ts'], notes: [],
    });
    const { exec } = fakeExec([
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: response } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } }),
    ], { exitCode: 124 });
    const runner = createCodexAgentRunner({ exec, collectChangedFiles: async () => ['src/a.ts'] });

    const outcome = await runner.run(
      { prompt: 'p', cwd: '/repo', tools: ['Read', 'Write'], model: 'gpt-5' },
      () => {},
    );

    expect(outcome).toMatchObject({
      status: 'success',
      output: expect.stringContaining('implemented'),
      stopReason: 'codex_cli_exit_124_after_result',
      tokensIn: 100,
      tokensOut: 20,
    });
  });

  it('does not pass Anthropic fallback model ids to Codex CLI', async () => {
    const { exec, calls } = fakeExec(['{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"ok"}}']);
    const runner = createCodexAgentRunner({ exec, collectChangedFiles: async () => [] });

    await runner.run(
      { prompt: 'p', cwd: '/repo', tools: [], model: 'claude-opus-4-8' },
      () => {},
    );

    expect(calls[0].args).not.toContain('--model');
    expect(calls[0].args).not.toContain('claude-opus-4-8');
  });
});
