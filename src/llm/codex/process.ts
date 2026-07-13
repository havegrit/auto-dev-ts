import { execFile, spawn } from 'child_process';
import { createInterface } from 'readline';

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExecCommand = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

/**
 * spawn 기반 스트리밍 실행기. stdout 을 줄 단위로 onStdoutLine 콜백에 흘리면서
 * 동시에 전체 stdout/stderr 를 모아 ExecResult 로 반환한다.
 * (JSONL 을 라이브로 파싱하기 위해 execFile 의 끝까지-버퍼링 대신 사용)
 */
export type ExecStream = (
  command: string,
  args: string[],
  options: ExecOptions,
  onStdoutLine: (line: string) => void,
) => Promise<ExecResult>;

export const execStream: ExecStream = (command, args, options, onStdoutLine) => new Promise((resolve) => {
  const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let cancelled = false;
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const timer = options.timeoutMs
    ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs)
    : undefined;

  const settle = (exitCode: number) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', onAbort);
    resolve({ exitCode: cancelled ? 130 : timedOut ? 124 : exitCode, stdout, stderr });
  };

  const onAbort = () => {
    if (settled || cancelled) return;
    cancelled = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, 1_000);
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    stdout += line + '\n';
    try { onStdoutLine(line); } catch { /* 콜백 오류가 실행을 중단시키지 않도록 격리 */ }
  });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  child.on('error', (err: NodeJS.ErrnoException) => {
    stderr += String(err.message ?? err);
    settle(err.code === 'ENOENT' ? 127 : 1);
  });
  child.on('close', (code) => settle(code ?? 0));
});

export const execCommand: ExecCommand = (command, args, options) => new Promise((resolve) => {
  execFile(command, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    const err = error as NodeJS.ErrnoException & { code?: string | number } | null;
    const exitCode = err
      ? (typeof err.code === 'number' ? err.code : err.code === 'ENOENT' ? 127 : 1)
      : 0;
    resolve({
      exitCode,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
    });
  });
});
