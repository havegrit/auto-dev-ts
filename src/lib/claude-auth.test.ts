import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAuthManager } from './claude-auth.js';

const LOGIN_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=expected-state';

function fakeQuery(overrides: {
  authenticate?: () => Promise<{ manualUrl?: string; automaticUrl?: string }>;
  callback?: (code: string, state: string) => Promise<unknown>;
} = {}) {
  return {
    claudeAuthenticate: vi.fn(overrides.authenticate ?? (async () => ({ manualUrl: LOGIN_URL }))),
    claudeOAuthCallback: vi.fn(overrides.callback ?? (async () => ({}))),
    close: vi.fn(),
  };
}

describe('ClaudeAuthManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports authenticated CLI status without exposing credentials', async () => {
    const manager = new ClaudeAuthManager({
      checkStatus: async () => ({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
      }),
    });

    await expect(manager.status()).resolves.toEqual({
      available: true,
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      phase: 'authenticated',
      loginUrl: undefined,
      error: undefined,
      startedAt: undefined,
      authenticatedAt: undefined,
    });
  });

  it('starts the SDK OAuth flow and exposes only the allowlisted manual URL', async () => {
    const oauthQuery = fakeQuery();
    const manager = new ClaudeAuthManager({
      checkStatus: async () => ({ loggedIn: false }),
      createQuery: () => oauthQuery as any,
    });

    const status = await manager.start();

    expect(oauthQuery.claudeAuthenticate).toHaveBeenCalledWith(true);
    expect(status).toEqual(expect.objectContaining({
      available: true,
      loggedIn: false,
      phase: 'awaiting_code',
      loginUrl: LOGIN_URL,
    }));
  });

  it('exchanges a matching code#state value and closes the OAuth query', async () => {
    const oauthQuery = fakeQuery();
    let loggedIn = false;
    const manager = new ClaudeAuthManager({
      checkStatus: async () => ({ loggedIn }),
      createQuery: () => oauthQuery as any,
    });
    await manager.start();
    loggedIn = true;

    const status = await manager.submitCode('authorization-code#expected-state');

    expect(oauthQuery.claudeOAuthCallback).toHaveBeenCalledWith('authorization-code', 'expected-state');
    expect(oauthQuery.close).toHaveBeenCalled();
    expect(status).toEqual(expect.objectContaining({
      loggedIn: true,
      phase: 'authenticated',
      authenticatedAt: expect.any(String),
    }));
  });

  it('rejects a code from another OAuth request before token exchange', async () => {
    const oauthQuery = fakeQuery();
    const manager = new ClaudeAuthManager({
      checkStatus: async () => ({ loggedIn: false }),
      createQuery: () => oauthQuery as any,
    });
    await manager.start();

    await expect(manager.submitCode('authorization-code#wrong-state')).rejects.toThrow(
      '로그인 코드가 현재 인증 요청과 일치하지 않습니다.',
    );
    expect(oauthQuery.claudeOAuthCallback).not.toHaveBeenCalled();
  });

  it('rejects a login URL outside Claude and Anthropic domains', async () => {
    const oauthQuery = fakeQuery({
      authenticate: async () => ({
        manualUrl: 'https://evil.example/oauth?state=expected-state',
      }),
    });
    const manager = new ClaudeAuthManager({
      checkStatus: async () => ({ loggedIn: false }),
      createQuery: () => oauthQuery as any,
    });

    const status = await manager.start();

    expect(status).toEqual(expect.objectContaining({
      phase: 'failed',
      error: 'Claude Code가 허용되지 않은 로그인 URL을 반환했습니다.',
    }));
    expect(oauthQuery.close).toHaveBeenCalled();
  });

  it('expires an abandoned login and closes its query', async () => {
    vi.useFakeTimers();
    const oauthQuery = fakeQuery();
    const manager = new ClaudeAuthManager({
      checkStatus: async () => ({ loggedIn: false }),
      createQuery: () => oauthQuery as any,
      loginTimeoutMs: 1_000,
    });
    await manager.start();

    await vi.advanceTimersByTimeAsync(1_001);
    const status = await manager.status();

    expect(status).toEqual(expect.objectContaining({
      phase: 'failed',
      error: '로그인 대기 시간이 만료되었습니다. 다시 시도하세요.',
    }));
    expect(oauthQuery.close).toHaveBeenCalled();
  });
});
