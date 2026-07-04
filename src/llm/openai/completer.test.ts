import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOpenAICompleter } from './completer.js';

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content } }] };
    },
    async text() {
      return JSON.stringify({ choices: [{ message: { content } }] });
    },
  } as unknown as Response;
}

const ENV = { ...process.env };

beforeEach(() => {
  process.env.AUTO_DEV_OPENAI_BASE_URL = 'https://integrate.api.nvidia.com/v1';
  process.env.AUTO_DEV_OPENAI_API_KEY = 'test-key';
  delete process.env.AUTO_DEV_OPENAI_MAX_TOKENS;
});

afterEach(() => {
  process.env = { ...ENV };
});

describe('openaiCompleter', () => {
  it('returns choices[0].message.content on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('hello'));
    const completer = createOpenAICompleter({ fetch: fetchMock });
    const out = await completer.complete({ message: 'hi', model: 'deepseek-ai/deepseek-v4-pro' });
    expect(out).toBe('hello');
  });

  it('POSTs to {baseURL}/chat/completions with bearer auth and model/messages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('ok'));
    const completer = createOpenAICompleter({ fetch: fetchMock });
    await completer.complete({ system: 'base', message: 'hi', model: 'deepseek-ai/deepseek-v4-pro' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('deepseek-ai/deepseek-v4-pro');
    expect(body.messages).toEqual([
      { role: 'system', content: 'base' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('omits the system message when no system is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('ok'));
    const completer = createOpenAICompleter({ fetch: fetchMock });
    await completer.complete({ message: 'hi', model: 'm' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('appends a JSON-only instruction to the system message when json is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('{}'));
    const completer = createOpenAICompleter({ fetch: fetchMock });
    await completer.complete({ system: 'base', message: 'hi', json: true, model: 'm' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('base');
    expect(body.messages[0].content).toContain('JSON');
  });

  it('sends max_tokens from AUTO_DEV_OPENAI_MAX_TOKENS when set', async () => {
    process.env.AUTO_DEV_OPENAI_MAX_TOKENS = '4096';
    const fetchMock = vi.fn().mockResolvedValue(okResponse('ok'));
    const completer = createOpenAICompleter({ fetch: fetchMock });
    await completer.complete({ message: 'hi', model: 'm' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(4096);
  });

  it('throws when AUTO_DEV_OPENAI_BASE_URL is missing', async () => {
    delete process.env.AUTO_DEV_OPENAI_BASE_URL;
    const completer = createOpenAICompleter({ fetch: vi.fn() });
    await expect(completer.complete({ message: 'hi', model: 'm' })).rejects.toThrow(/AUTO_DEV_OPENAI_BASE_URL/);
  });

  it('throws with status and body on a non-ok response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      async text() {
        return 'rate limited';
      },
    } as unknown as Response);
    const completer = createOpenAICompleter({ fetch: fetchMock });
    await expect(completer.complete({ message: 'hi', model: 'm' })).rejects.toThrow(/429.*rate limited/s);
  });
});
