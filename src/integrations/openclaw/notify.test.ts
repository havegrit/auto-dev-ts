import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFile, readFile } = vi.hoisted(() => ({
  execFile: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile }));
vi.mock('node:fs/promises', () => ({ readFile }));

import { formatOpenClawSpecNotice, notifyOpenClawSpec } from './notify.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  execFile.mockImplementation((_command, _args, _options, callback) => callback(null, '', ''));
  readFile.mockResolvedValue(JSON.stringify({
    channels: {
      telegram: {
        accounts: {
          main: { allowFrom: ['telegram:123456'] },
        },
      },
    },
  }));
});

describe('notifyOpenClawSpec', () => {
  it('does nothing unless the integration is enabled', async () => {
    await expect(notifyOpenClawSpec({ runId: 'run-1', verdict: 'SHIP' })).resolves.toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('sends through the configured OpenClaw main Telegram account', async () => {
    vi.stubEnv('AUTO_DEV_OPENCLAW_ENABLED', 'true');
    vi.stubEnv('AUTO_DEV_OPENCLAW_COMMAND', '/opt/openclaw');
    vi.stubEnv('AUTO_DEV_OPENCLAW_CONFIG_PATH', '/config/openclaw.json');

    await expect(notifyOpenClawSpec({
      runId: 'run-1',
      project: 'demo',
      verdict: 'SHIP',
      durationMs: 65_000,
    })).resolves.toBe(true);

    expect(readFile).toHaveBeenCalledWith('/config/openclaw.json', 'utf8');
    expect(execFile).toHaveBeenCalledWith(
      '/opt/openclaw',
      expect.arrayContaining([
        '--channel', 'telegram',
        '--account', 'main',
        '--target', '123456',
      ]),
      expect.objectContaining({ timeout: 20_000 }),
      expect.any(Function),
    );
    const args = execFile.mock.calls[0][1] as string[];
    expect(args[args.indexOf('--message') + 1]).toContain('✅ auto-dev 스펙 완료');
  });

  it('uses an explicit target without reading OpenClaw credentials', async () => {
    vi.stubEnv('AUTO_DEV_OPENCLAW_ENABLED', 'true');
    vi.stubEnv('AUTO_DEV_OPENCLAW_TARGET', '987654');

    await notifyOpenClawSpec({ runId: 'run-2', verdict: 'FAILED', reason: 'provider failed' });

    expect(readFile).not.toHaveBeenCalled();
    expect(execFile.mock.calls[0][1]).toEqual(expect.arrayContaining(['--target', '987654']));
  });
});

describe('formatOpenClawSpecNotice', () => {
  it('formats clarification and failure notices without dumping unbounded output', () => {
    const text = formatOpenClawSpecNotice({
      runId: 'run-3',
      verdict: 'NEEDS-CLARIFICATION',
      clarificationCount: 2,
      reason: 'x'.repeat(900),
    });
    expect(text).toContain('❓ auto-dev 입력 필요');
    expect(text).toContain('확인 질문: 2개');
    expect(text.length).toBeLessThan(900);
  });
});
