import type { Completer, CompleteRequest } from '../types.js';
import { shouldPassModelToCodex } from './model.js';
import { execCommand, execStream, type ExecCommand, type ExecStream } from './process.js';
import { foldCodexLine, newCodexStreamState, resultText } from './stream.js';

interface CodexCompleterDeps {
  exec?: ExecCommand;
  streamExec?: ExecStream;
}

function buildPrompt(req: CompleteRequest): string {
  const system = req.system ? `${req.system}\n\n---\n\n` : '';
  const prompt = `${system}${req.message}`;
  if (!req.json) return prompt;
  return `${prompt}\n\n반드시 유효한 JSON 객체 하나만 출력하세요. 코드펜스나 설명 문구 없이 JSON만 반환하세요.`;
}

export function createCodexCompleter(deps: CodexCompleterDeps = {}): Completer {
  const exec = deps.exec ?? execCommand;
  const runStream = deps.streamExec ?? execStream;

  return {
    async complete(req: CompleteRequest): Promise<string> {
      const args = ['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check'];
      if (shouldPassModelToCodex(req.model)) args.push('--model', req.model);
      args.push(buildPrompt(req));
      const result = await exec(process.env.AUTO_DEV_CODEX_COMMAND ?? 'codex', args, {
        cwd: process.cwd(),
        timeoutMs: Number(process.env.AUTO_DEV_CODEX_TIMEOUT_MS ?? 600_000),
      });
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `codex exited ${result.exitCode}`);
      return result.stdout.trim();
    },

    async stream(req: CompleteRequest, onText: (text: string) => void): Promise<string> {
      const args = ['exec', '--json', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check'];
      if (shouldPassModelToCodex(req.model)) args.push('--model', req.model);
      args.push(buildPrompt(req));
      const state = newCodexStreamState();
      const result = await runStream(
        process.env.AUTO_DEV_CODEX_COMMAND ?? 'codex',
        args,
        {
          cwd: process.cwd(),
          timeoutMs: Number(process.env.AUTO_DEV_CODEX_TIMEOUT_MS ?? 600_000),
          signal: req.signal,
        },
        (line) => {
          for (const event of foldCodexLine(line, state)) {
            if (event.kind === 'text' && event.text) onText(event.text);
          }
        },
      );
      if (req.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `codex exited ${result.exitCode}`);
      return resultText(state) || result.stdout.trim();
    },
  };
}

export const codexCompleter = createCodexCompleter();
