import { describe, expect, it } from 'vitest';
import { createCodexCompleter } from './completer.js';

describe('codexCompleter', () => {
  it('does not append the agent JSON result contract for normal completions', async () => {
    let prompt = '';
    const completer = createCodexCompleter({
      exec: async (_cmd, args) => {
        prompt = String(args.at(-1));
        return { exitCode: 0, stdout: 'plain answer', stderr: '' };
      },
    });

    const output = await completer.complete({ message: 'hello' });

    expect(output).toBe('plain answer');
    expect(prompt).toBe('hello');
    expect(prompt).not.toContain('"changedFiles"');
  });

  it('requests a single JSON object for JSON completions', async () => {
    let prompt = '';
    const completer = createCodexCompleter({
      exec: async (_cmd, args) => {
        prompt = String(args.at(-1));
        return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
      },
    });

    await completer.complete({ system: 'sys', message: 'msg', json: true, model: 'gpt-5' });

    expect(prompt).toContain('sys');
    expect(prompt).toContain('msg');
    expect(prompt).toContain('유효한 JSON 객체 하나만');
  });

  it('does not pass Anthropic fallback model ids to Codex CLI', async () => {
    let args: string[] = [];
    const completer = createCodexCompleter({
      exec: async (_cmd, receivedArgs) => {
        args = receivedArgs;
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    });

    await completer.complete({ message: 'hello', model: 'claude-opus-4-8' });

    expect(args).not.toContain('--model');
    expect(args).not.toContain('claude-opus-4-8');
  });
});
