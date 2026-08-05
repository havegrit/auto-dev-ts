import { execFile } from 'node:child_process';
import { query, type Query } from '@anthropic-ai/claude-agent-sdk';

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const CLAUDE_COMMAND = process.env.AUTO_DEV_CLAUDE_COMMAND ?? 'claude';

export type ClaudeAuthPhase =
  | 'idle'
  | 'starting'
  | 'awaiting_code'
  | 'exchanging'
  | 'authenticated'
  | 'failed';

export interface ClaudeAuthStatus {
  available: boolean;
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  phase: ClaudeAuthPhase;
  loginUrl?: string;
  error?: string;
  startedAt?: string;
  authenticatedAt?: string;
}

interface ClaudeCliAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
}

interface ClaudeOAuthQuery extends Query {
  claudeAuthenticate(loginWithClaudeAi?: boolean): Promise<{
    manualUrl?: string;
    automaticUrl?: string;
  }>;
  claudeOAuthCallback(authorizationCode: string, state: string): Promise<unknown>;
}

export interface ClaudeAuthManagerDeps {
  checkStatus?: () => Promise<ClaudeCliAuthStatus>;
  createQuery?: () => ClaudeOAuthQuery;
  loginTimeoutMs?: number;
}

interface ActiveLogin {
  query: ClaudeOAuthQuery;
  state?: string;
  loginUrl?: string;
  startedAt: string;
  timeout: ReturnType<typeof setTimeout>;
}

function runClaudeAuthStatus(): Promise<ClaudeCliAuthStatus> {
  return new Promise((resolve, reject) => {
    execFile(
      CLAUDE_COMMAND,
      ['auth', 'status'],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = String(stdout ?? '').trim();
        if (output) {
          try {
            const parsed = JSON.parse(output) as Partial<ClaudeCliAuthStatus>;
            if (typeof parsed.loggedIn === 'boolean') {
              resolve({
                loggedIn: parsed.loggedIn,
                authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined,
                apiProvider: typeof parsed.apiProvider === 'string' ? parsed.apiProvider : undefined,
              });
              return;
            }
          } catch {
            // 아래의 안전한 일반 오류로 처리한다.
          }
        }

        const err = error as NodeJS.ErrnoException | null;
        if (err?.code === 'ENOENT') {
          reject(new Error('Claude Code CLI를 찾을 수 없습니다.'));
          return;
        }
        reject(new Error(publicError(stderr || error || 'Claude 인증 상태를 확인하지 못했습니다.')));
      },
    );
  });
}

async function* idlePrompt(): AsyncGenerator<never, void, unknown> {
  await new Promise<void>(() => {});
}

function createOAuthQuery(): ClaudeOAuthQuery {
  return query({
    prompt: idlePrompt(),
    options: {
      cwd: process.cwd(),
      allowedTools: [],
    },
  }) as ClaudeOAuthQuery;
}

function publicError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  const sanitized = raw
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/\b(?:sk-ant-|sk-)[A-Za-z0-9_-]+\b/g, '<redacted>')
    .replace(/[A-Za-z0-9_-]{80,}/g, '<redacted>')
    .trim();
  return sanitized.slice(0, 500) || 'Claude 인증 처리에 실패했습니다.';
}

function loginUrlDetails(value: string | undefined): { url: string; state: string } {
  if (!value) throw new Error('Claude Code가 로그인 URL을 반환하지 않았습니다.');
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const allowedHost = host === 'claude.com'
    || host.endsWith('.claude.com')
    || host === 'claude.ai'
    || host.endsWith('.claude.ai')
    || host === 'anthropic.com'
    || host.endsWith('.anthropic.com');
  if (url.protocol !== 'https:' || !allowedHost) {
    throw new Error('Claude Code가 허용되지 않은 로그인 URL을 반환했습니다.');
  }
  const state = url.searchParams.get('state');
  if (!state) throw new Error('Claude 로그인 URL에 state 값이 없습니다.');
  return { url: url.toString(), state };
}

function parsePastedCode(value: string, expectedState: string): { code: string; state: string } {
  const pasted = value.trim();
  if (!pasted || pasted.length > 4096 || /\s/.test(pasted)) {
    throw new Error('브라우저에 표시된 전체 코드(code#state)를 붙여넣으세요.');
  }
  const separator = pasted.lastIndexOf('#');
  if (separator <= 0 || separator === pasted.length - 1) {
    throw new Error('전체 코드 형식이 아닙니다. code#state 값을 붙여넣으세요.');
  }
  const code = pasted.slice(0, separator);
  const state = pasted.slice(separator + 1);
  if (state !== expectedState) {
    throw new Error('로그인 코드가 현재 인증 요청과 일치하지 않습니다. 로그인을 다시 시작하세요.');
  }
  return { code, state };
}

export class ClaudeAuthManager {
  private readonly checkStatus: () => Promise<ClaudeCliAuthStatus>;
  private readonly createQuery: () => ClaudeOAuthQuery;
  private readonly loginTimeoutMs: number;
  private active?: ActiveLogin;
  private phase: ClaudeAuthPhase = 'idle';
  private lastError?: string;
  private authenticatedAt?: string;

  constructor(deps: ClaudeAuthManagerDeps = {}) {
    this.checkStatus = deps.checkStatus ?? runClaudeAuthStatus;
    this.createQuery = deps.createQuery ?? createOAuthQuery;
    this.loginTimeoutMs = deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
  }

  async status(): Promise<ClaudeAuthStatus> {
    let cliStatus: ClaudeCliAuthStatus;
    try {
      cliStatus = await this.checkStatus();
    } catch (err) {
      return {
        available: false,
        loggedIn: false,
        phase: this.phase === 'idle' ? 'failed' : this.phase,
        loginUrl: this.active?.loginUrl,
        error: this.lastError ?? publicError(err),
        startedAt: this.active?.startedAt,
        authenticatedAt: this.authenticatedAt,
      };
    }

    if (cliStatus.loggedIn && !this.active) {
      this.phase = 'authenticated';
      this.lastError = undefined;
    } else if (!cliStatus.loggedIn && !this.active && this.phase === 'authenticated') {
      this.phase = 'idle';
      this.authenticatedAt = undefined;
    }

    return {
      available: true,
      ...cliStatus,
      phase: this.phase,
      loginUrl: this.active?.loginUrl,
      error: this.lastError,
      startedAt: this.active?.startedAt,
      authenticatedAt: this.authenticatedAt,
    };
  }

  async start(): Promise<ClaudeAuthStatus> {
    if (this.active && ['starting', 'awaiting_code', 'exchanging'].includes(this.phase)) {
      return this.status();
    }

    this.closeActive();
    this.phase = 'starting';
    this.lastError = undefined;
    const oauthQuery = this.createQuery();
    const startedAt = new Date().toISOString();
    const timeout = setTimeout(() => {
      if (this.active?.query !== oauthQuery) return;
      this.fail('로그인 대기 시간이 만료되었습니다. 다시 시도하세요.');
    }, this.loginTimeoutMs);
    timeout.unref?.();
    this.active = { query: oauthQuery, startedAt, timeout };

    try {
      const result = await oauthQuery.claudeAuthenticate(true);
      const { url, state } = loginUrlDetails(result.manualUrl);
      if (this.active?.query !== oauthQuery) {
        throw new Error('Claude 로그인 요청이 만료되었습니다.');
      }
      this.active.state = state;
      this.active.loginUrl = url;
      this.phase = 'awaiting_code';
      return this.status();
    } catch (err) {
      if (this.active?.query === oauthQuery) {
        this.fail(publicError(err));
      } else {
        oauthQuery.close();
      }
      return this.status();
    }
  }

  async submitCode(pastedCode: string): Promise<ClaudeAuthStatus> {
    const active = this.active;
    if (!active?.state || this.phase !== 'awaiting_code') {
      throw new Error('진행 중인 Claude 로그인 요청이 없습니다.');
    }
    const { code, state } = parsePastedCode(pastedCode, active.state);
    this.phase = 'exchanging';
    this.lastError = undefined;

    try {
      await active.query.claudeOAuthCallback(code, state);
      if (this.active?.query !== active.query) {
        throw new Error('Claude 로그인 요청이 만료되었습니다.');
      }
      this.authenticatedAt = new Date().toISOString();
      this.phase = 'authenticated';
      this.closeActive(false);
      return this.status();
    } catch (err) {
      if (this.active?.query === active.query) {
        this.fail(publicError(err));
      }
      throw new Error(this.lastError ?? publicError(err));
    }
  }

  reset(): void {
    this.closeActive();
    this.phase = 'idle';
    this.lastError = undefined;
  }

  private fail(message: string): void {
    this.lastError = message;
    this.phase = 'failed';
    this.closeActive(false);
  }

  private closeActive(clearPhase = true): void {
    if (this.active) {
      clearTimeout(this.active.timeout);
      this.active.query.close();
      this.active = undefined;
    }
    if (clearPhase && ['starting', 'awaiting_code', 'exchanging'].includes(this.phase)) {
      this.phase = 'idle';
    }
  }
}

export const claudeAuth = new ClaudeAuthManager();
