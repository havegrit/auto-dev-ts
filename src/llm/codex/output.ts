import type { AgentRunOutcome } from '../types.js';

interface CodexJsonResult {
  status?: string;
  summary?: string;
  changedFiles?: unknown;
  tests?: unknown;
  notes?: unknown;
}

export interface NormalizeInput {
  exitCode: number;
  /** 에이전트의 최종 응답 텍스트(JSONL 모드에서는 마지막 agent_message). JSON 계약 추출 대상. */
  stdout: string;
  stderr: string;
  gitChangedFiles: string[];
  tokensIn?: number;
  tokensOut?: number;
}

function stripFence(text: string): string {
  const fence = text.trim().match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fence ? fence[1].trim() : text.trim();
}

export function extractJsonObject(text: string): CodexJsonResult | undefined {
  const stripped = stripFence(text);
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(stripped.slice(start, end + 1)) as CodexJsonResult;
  } catch {
    return undefined;
  }
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function mergeChangedFiles(fromJson: string[], fromGit: string[]): string[] {
  return [...new Set([...fromJson, ...fromGit])];
}

function outputWithStderr(stdout: string, stderr: string): string {
  const out = stdout.trim();
  const err = stderr.trim();
  if (!err) return out;
  return out ? `${out}\n\nstderr:\n${err}` : `stderr:\n${err}`;
}

function authFailure(stderr: string, stdout: string): boolean {
  return /auth|login|logged in|sign in|인증|로그인/i.test(`${stderr}\n${stdout}`);
}

interface CodexTests {
  command?: string;
  result?: string;
}

/**
 * 계약 JSON을 대시보드 마크다운 렌더러가 보기 좋게 그릴 수 있는 섹션 형태로 포맷한다.
 * (raw JSON 덩어리를 그대로 노출하지 않기 위함 — UX 개선)
 */
export function formatCodexMarkdown(parsed: CodexJsonResult, changedFiles: string[]): string {
  const parts: string[] = [];
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (summary) parts.push(summary);

  if (changedFiles.length > 0) {
    parts.push(['**변경된 파일**', ...changedFiles.map((f) => `- \`${f}\``)].join('\n'));
  }

  const tests = (parsed.tests ?? undefined) as CodexTests | undefined;
  if (tests && (tests.command || tests.result)) {
    const cmd = tests.command ? `\`${tests.command}\`` : '';
    const res = tests.result ? `${cmd ? ' → ' : ''}${tests.result}` : '';
    parts.push(`**테스트**: ${cmd}${res}`.trim());
  }

  const notes = arrayOfStrings(parsed.notes);
  if (notes.length > 0) parts.push(['**참고**', ...notes.map((n) => `- ${n}`)].join('\n'));

  return parts.join('\n\n');
}

export function normalizeCodexResult(input: NormalizeInput): AgentRunOutcome {
  const parsed = extractJsonObject(input.stdout);
  const jsonChangedFiles = arrayOfStrings(parsed?.changedFiles);
  const changedFiles = mergeChangedFiles(jsonChangedFiles, input.gitChangedFiles);
  const isSuccess = input.exitCode === 0 && parsed?.status !== 'failed' && parsed?.status !== 'error';
  const combinedOutput = outputWithStderr(input.stdout, input.stderr);
  const errorText = input.stderr.trim() || input.stdout.trim() || combinedOutput;
  const output = parsed && isSuccess ? formatCodexMarkdown(parsed, changedFiles) : combinedOutput;

  return {
    status: isSuccess ? 'success' : 'error',
    output,
    rawOutput: combinedOutput,
    changedFiles,
    tokensIn: input.tokensIn ?? 0,
    tokensOut: input.tokensOut ?? 0,
    numTurns: 1,
    stopReason: `codex_cli_exit_${input.exitCode}`,
    ...(isSuccess ? {} : {
      errorType: authFailure(input.stderr, input.stdout) ? 'codex_auth_failed' : `codex_cli_exit_${input.exitCode}`,
      errors: [errorText].filter(Boolean),
    }),
  };
}

export function appendCodexJsonContract(prompt: string): string {
  return `${prompt.trim()}\n\n---\n\n` +
    '마지막 응답은 반드시 다음 JSON 객체 형식으로 출력하세요. 코드펜스나 추가 설명 없이 JSON만 반환하세요.\n' +
    '{\n' +
    '  "status": "success",\n' +
    '  "summary": "작업 요약",\n' +
    '  "changedFiles": ["src/example.ts"],\n' +
    '  "tests": { "command": "npm test", "result": "passed" },\n' +
    '  "notes": []\n' +
    '}';
}
