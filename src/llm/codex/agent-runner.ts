import type { AgentRunner, AgentRunRequest, AgentEvent, AgentRunOutcome } from '../types.js';
import { collectGitChangedFiles } from './git.js';
import { shouldPassModelToCodex } from './model.js';
import { appendCodexJsonContract, normalizeCodexResult } from './output.js';
import { execCommand, type ExecCommand } from './process.js';

interface CodexAgentRunnerDeps {
  exec?: ExecCommand;
  collectChangedFiles?: (repoPath: string) => Promise<string[]>;
}

function timeoutMs(): number {
  const raw = process.env.AUTO_DEV_CODEX_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : 600_000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
}

function codexArgs(req: AgentRunRequest): string[] {
  const args = ['exec', '--cd', req.cwd];
  if (shouldPassModelToCodex(req.model)) args.push('--model', req.model);
  args.push(appendCodexJsonContract(req.prompt));
  return args;
}

export function createCodexAgentRunner(deps: CodexAgentRunnerDeps = {}): AgentRunner {
  const exec = deps.exec ?? execCommand;
  const collectChangedFiles = deps.collectChangedFiles ?? ((repoPath) => collectGitChangedFiles(repoPath, exec));

  return {
    async run(req: AgentRunRequest, onEvent: (e: AgentEvent) => void): Promise<AgentRunOutcome> {
      const result = await exec(process.env.AUTO_DEV_CODEX_COMMAND ?? 'codex', codexArgs(req), {
        cwd: req.cwd,
        timeoutMs: timeoutMs(),
      });
      const gitChangedFiles = await collectChangedFiles(req.cwd).catch(() => []);
      const outcome = normalizeCodexResult({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        gitChangedFiles,
      });

      if (outcome.output) onEvent({ kind: 'text', text: outcome.output });
      return outcome;
    },
  };
}

export const codexAgentRunner = createCodexAgentRunner();
