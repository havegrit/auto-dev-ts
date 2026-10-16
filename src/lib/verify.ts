import { spawn } from 'node:child_process';
import type { VerifyConfig } from './project-config.js';

/** 출력 꼬리 보관 한도. 둘 중 먼저 걸리는 쪽으로 자른다. */
export const VERIFY_TAIL_MAX_LINES = 200;
export const VERIFY_TAIL_MAX_BYTES = 20 * 1024;
/** SIGTERM 후 프로세스 그룹이 스스로 정리할 시간. 지나면 SIGKILL. */
export const VERIFY_KILL_GRACE_MS = 5_000;

export interface VerifyOutcome {
  /** 시그널로 종료되면 null. */
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /** stdout + stderr 를 합친 마지막 꼬리. */
  outputTail: string;
}

/** 통과는 오직 "정상 종료 + 종료 코드 0" 뿐이다. */
export function verifyPassed(outcome: VerifyOutcome): boolean {
  return outcome.exitCode === 0 && !outcome.timedOut && !outcome.cancelled;
}

export function verifyFailureReason(outcome: VerifyOutcome): string {
  if (outcome.cancelled) return 'cancelled';
  if (outcome.timedOut) return 'timed out';
  return `exit code ${outcome.exitCode ?? 'signal'}`;
}

/** 누적 출력에서 마지막 N줄 / N바이트만 남긴다. */
function tail(buffer: string): string {
  const lines = buffer.split('\n');
  let result = lines.slice(-VERIFY_TAIL_MAX_LINES).join('\n');
  while (Buffer.byteLength(result, 'utf-8') > VERIFY_TAIL_MAX_BYTES) {
    const cut = result.indexOf('\n');
    if (cut < 0) {
      result = result.slice(-VERIFY_TAIL_MAX_BYTES);
      break;
    }
    result = result.slice(cut + 1);
  }
  return result;
}

/**
 * 검증 명령을 직접 실행하고 종료 코드를 관찰한다.
 *
 * LLM 의 자기 보고(`[TESTS: PASS]`)와 달리 이 함수의 결과는 위조할 수 없다.
 * 오케스트레이터의 통과 판정은 여기서 나온 종료 코드를 근거로 한다.
 *
 * `detached: true` 로 띄워 자식이 프로세스 그룹 리더가 되게 하고, 타임아웃·취소 시
 * 그룹 전체(`-pid`)를 종료한다. 빌드 도구가 띄운 손자 프로세스(데몬, 테스트 러너)가
 * 살아남아 다음 run 의 포트·락을 점유하는 것을 막기 위해서다.
 */
export function runVerify(
  projectDir: string,
  config: VerifyConfig,
  opts: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<VerifyOutcome> {
  const start = Date.now();

  return new Promise<VerifyOutcome>((resolve) => {
    let buffer = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const child = spawn('bash', ['-c', config.command], {
      cwd: projectDir,
      detached: true,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const collect = (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      // 장시간 빌드의 전체 로그를 메모리에 쌓지 않는다. 꼬리만 남기면 충분하다.
      if (buffer.length > VERIFY_TAIL_MAX_BYTES * 4) buffer = tail(buffer);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = () => {
      const pid = child.pid;
      if (pid === undefined) return;
      try { process.kill(-pid, 'SIGTERM'); } catch { /* 이미 종료 */ }
      killTimer = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* 이미 종료 */ }
      }, VERIFY_KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, config.timeoutMs);

    const onAbort = () => {
      cancelled = true;
      killGroup();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        timedOut,
        cancelled,
        durationMs: Date.now() - start,
        outputTail: tail(buffer).trim(),
      });
    };

    child.on('error', (err) => {
      buffer += `\n${err instanceof Error ? err.message : String(err)}`;
      settle(null);
    });
    child.on('close', (code) => settle(code));
  });
}
