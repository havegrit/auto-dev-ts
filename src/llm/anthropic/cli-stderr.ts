import { log } from '../../lib/logger.js';

/**
 * Claude Code CLI 서브프로세스의 stderr를 수집한다.
 *
 * SDK의 query()는 프로세스가 죽으면 "Claude Code process exited with code N"만
 * 던지고 실제 원인(예: root에서 --dangerously-skip-permissions 거부)은 stderr로 흘린다.
 * onStderr를 query options.stderr로 넘긴 뒤, 실패 시 text()로 진짜 메시지를 복구한다.
 */
export interface StderrCollector {
  onStderr(data: string): void;
  text(): string;
}

export function createStderrCollector(): StderrCollector {
  const lines: string[] = [];
  return {
    onStderr(data: string): void {
      const text = data.trim();
      if (!text) return;
      lines.push(text);
      log.debug({ stderr: text }, 'claude-cli stderr');
    },
    text(): string {
      return lines.join('\n').trim();
    },
  };
}

/**
 * SDK 에러에 수집된 stderr를 덧붙여, "exited with code 1" 대신 실제 원인이 보이게 한다.
 * 수집된 stderr가 없으면 원본 에러를 그대로 돌려준다.
 */
export function withStderr(err: unknown, stderr: string): Error {
  if (!stderr) return err instanceof Error ? err : new Error(String(err));
  const base = err instanceof Error ? err.message : String(err);
  return new Error(`${base} — claude-cli stderr: ${stderr}`);
}
