import type { AgentRunner, AgentRunRequest, AgentEvent, AgentRunOutcome } from '../types.js';
import { collectGitChangedFiles } from './git.js';
import { shouldPassModelToCodex } from './model.js';
import { appendCodexJsonContract, normalizeCodexResult } from './output.js';
import { execStream, type ExecStream } from './process.js';
import { newCodexStreamState, foldCodexLine, resultText } from './stream.js';

interface CodexAgentRunnerDeps {
  exec?: ExecStream;
  collectChangedFiles?: (repoPath: string) => Promise<string[]>;
}

function timeoutMs(): number {
  const raw = process.env.AUTO_DEV_CODEX_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : 600_000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
}

function codexArgs(req: AgentRunRequest): string[] {
  // --json: 이벤트를 JSONL 로 흘려 실행 중 진행 상황을 라이브로 받는다.
  const args = ['exec', '--json', '--cd', req.cwd];
  if (shouldPassModelToCodex(req.model)) args.push('--model', req.model);
  args.push(appendCodexJsonContract(req.prompt));
  return args;
}

export function createCodexAgentRunner(deps: CodexAgentRunnerDeps = {}): AgentRunner {
  const exec = deps.exec ?? execStream;
  // git 조회는 버퍼링 실행기(execCommand)를 그대로 쓴다(스트리밍 불필요).
  const collectChangedFiles = deps.collectChangedFiles ?? ((repoPath) => collectGitChangedFiles(repoPath));

  return {
    async run(req: AgentRunRequest, onEvent: (e: AgentEvent) => void): Promise<AgentRunOutcome> {
      const state = newCodexStreamState();
      const result = await exec(
        process.env.AUTO_DEV_CODEX_COMMAND ?? 'codex',
        codexArgs(req),
        { cwd: req.cwd, timeoutMs: timeoutMs() },
        (line) => {
          for (const event of foldCodexLine(line, state)) onEvent(event);
        },
      );

      const gitChangedFiles = await collectChangedFiles(req.cwd).catch(() => []);
      return normalizeCodexResult({
        exitCode: result.exitCode,
        // JSON 계약 추출 대상은 에이전트의 마지막 메시지. 없으면 raw stdout 로 폴백.
        stdout: resultText(state) || result.stdout,
        stderr: result.stderr,
        gitChangedFiles,
        tokensIn: state.tokensIn,
        tokensOut: state.tokensOut,
      });
    },
  };
}

export const codexAgentRunner = createCodexAgentRunner();
