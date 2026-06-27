import { describe, expect, it } from 'vitest';
import { createCodexAgentRunner } from './agent-runner.js';
import type { AgentEvent } from '../types.js';

describe('codexAgentRunner', () => {
  it('runs codex exec in the requested repository and merges git changed files', async () => {
    const calls: any[] = [];
    const runner = createCodexAgentRunner({
      exec: async (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return {
          exitCode: 0,
          stdout: '{"status":"success","summary":"done","changedFiles":["src/model.ts"],"notes":[]}',
          stderr: '',
        };
      },
      collectChangedFiles: async () => ['src/model.ts', 'src/actual.ts'],
    });
    const events: AgentEvent[] = [];

    const outcome = await runner.run(
      { prompt: 'implement feature', cwd: '/repo', tools: ['Read', 'Write'], model: 'gpt-5', effort: 'high' },
      (event) => events.push(event),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('codex');
    expect(calls[0].args.slice(0, 2)).toEqual(['exec', '--cd']);
    expect(calls[0].args[2]).toBe('/repo');
    expect(calls[0].args).toContain('--model');
    expect(calls[0].options.cwd).toBe('/repo');
    expect(calls[0].args.at(-1)).toContain('implement feature');
    expect(calls[0].args.at(-1)).toContain('"changedFiles"');
    expect(outcome).toMatchObject({
      status: 'success',
      output: 'done',
      changedFiles: ['src/model.ts', 'src/actual.ts'],
      tokensIn: 0,
      tokensOut: 0,
    });
    expect(events).toContainEqual({ kind: 'text', text: 'done' });
  });

  it('maps codex process failures to an error outcome instead of throwing', async () => {
    const runner = createCodexAgentRunner({
      exec: async () => ({ exitCode: 124, stdout: '', stderr: 'timed out' }),
      collectChangedFiles: async () => [],
    });

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

  it('does not pass Anthropic fallback model ids to Codex CLI', async () => {
    let args: string[] = [];
    const runner = createCodexAgentRunner({
      exec: async (_cmd, receivedArgs) => {
        args = receivedArgs;
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      collectChangedFiles: async () => [],
    });

    await runner.run(
      { prompt: 'p', cwd: '/repo', tools: [], model: 'claude-opus-4-8' },
      () => {},
    );

    expect(args).not.toContain('--model');
    expect(args).not.toContain('claude-opus-4-8');
  });
});
