import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_CONFIG_PATH = `${process.env.HOME ?? ''}/.openclaw/openclaw.json`;
const DEFAULT_COMMAND = 'openclaw';
const DEFAULT_ACCOUNT = 'main';
const MAX_REASON_LENGTH = 700;

export interface OpenClawSpecNotice {
  runId: string;
  project?: string;
  verdict: string;
  durationMs?: number;
  reason?: string;
  clarificationCount?: number;
}

interface OpenClawConfig {
  channels?: {
    telegram?: {
      allowFrom?: Array<string | number>;
      accounts?: Record<string, {
        allowFrom?: Array<string | number>;
      }>;
    };
  };
}

function enabled(): boolean {
  return process.env.AUTO_DEV_OPENCLAW_ENABLED?.trim().toLowerCase() === 'true';
}

function normalizeTarget(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const target = String(value).trim().replace(/^(telegram|tg):/i, '');
  return target || undefined;
}

async function resolveTarget(account: string): Promise<string | undefined> {
  const configured = normalizeTarget(process.env.AUTO_DEV_OPENCLAW_TARGET);
  if (configured) return configured;

  const configPath = process.env.AUTO_DEV_OPENCLAW_CONFIG_PATH?.trim() || DEFAULT_CONFIG_PATH;
  const config = JSON.parse(await readFile(configPath, 'utf8')) as OpenClawConfig;
  return normalizeTarget(
    config.channels?.telegram?.accounts?.[account]?.allowFrom?.[0]
      ?? config.channels?.telegram?.allowFrom?.[0],
  );
}

function durationText(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return undefined;
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}초`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}분 ${seconds}초` : `${minutes}분`;
}

function noticeTitle(notice: OpenClawSpecNotice): string {
  if (notice.verdict === 'SHIP') return '✅ auto-dev 스펙 완료';
  if (notice.verdict === 'NEEDS-CLARIFICATION') return '❓ auto-dev 입력 필요';
  if (notice.verdict === 'CANCELLED') return '⛔ auto-dev 스펙 취소';
  return '❌ auto-dev 스펙 실패';
}

export function formatOpenClawSpecNotice(notice: OpenClawSpecNotice): string {
  const elapsed = durationText(notice.durationMs);
  const lines = [
    noticeTitle(notice),
    `실행 ID: ${notice.runId}`,
    notice.project ? `프로젝트: ${notice.project}` : undefined,
    `결과: ${notice.verdict}`,
    elapsed ? `소요: ${elapsed}` : undefined,
    notice.clarificationCount
      ? `확인 질문: ${notice.clarificationCount}개 (대시보드에서 답변 필요)`
      : undefined,
    notice.reason
      ? `원인: ${notice.reason.trim().slice(0, MAX_REASON_LENGTH)}`
      : undefined,
  ];
  return lines.filter((line): line is string => Boolean(line)).join('\n');
}

/**
 * OpenClaw가 이미 관리하는 Telegram 계정으로 직접 알림을 보낸다.
 * 알림 실패가 spec 실행 상태를 실패로 뒤집지 않도록 모든 오류를 내부에서 처리한다.
 */
export async function notifyOpenClawSpec(notice: OpenClawSpecNotice): Promise<boolean> {
  if (!enabled()) return false;

  const account = process.env.AUTO_DEV_OPENCLAW_ACCOUNT?.trim() || DEFAULT_ACCOUNT;
  try {
    const target = await resolveTarget(account);
    if (!target) throw new Error(`Telegram target is not configured for account "${account}"`);

    const command = process.env.AUTO_DEV_OPENCLAW_COMMAND?.trim() || DEFAULT_COMMAND;
    await execFileAsync(command, [
      'message',
      'send',
      '--channel',
      'telegram',
      '--account',
      account,
      '--target',
      target,
      '--message',
      formatOpenClawSpecNotice(notice),
    ], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[openclaw] Telegram notification failed: ${message}`);
    return false;
  }
}
