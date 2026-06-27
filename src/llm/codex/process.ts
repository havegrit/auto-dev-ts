import { execFile } from 'child_process';

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExecCommand = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

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
