import type { Completer, CompleteRequest } from '../types.js';

/** 주입 가능한 fetch — 테스트에서 목킹한다. 기본값은 전역 fetch(Node 24+). */
export type FetchFn = typeof fetch;

interface OpenAICompleterDeps {
  fetch?: FetchFn;
}

const JSON_INSTRUCTION =
  '반드시 유효한 JSON 객체 하나만 출력하세요. 코드펜스(```)나 설명 문구 없이 JSON만 반환하세요.';

function baseUrl(): string {
  const url = process.env.AUTO_DEV_OPENAI_BASE_URL;
  if (!url) throw new Error('AUTO_DEV_OPENAI_BASE_URL is not set');
  return url.replace(/\/+$/, '');
}

function maxTokens(): number | undefined {
  const raw = process.env.AUTO_DEV_OPENAI_MAX_TOKENS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function createOpenAICompleter(deps: OpenAICompleterDeps = {}): Completer {
  const doFetch = deps.fetch ?? fetch;

  function requestParts(req: CompleteRequest, stream: boolean) {
    const url = `${baseUrl()}/chat/completions`;
    const apiKey = process.env.AUTO_DEV_OPENAI_API_KEY ?? '';

    let system = req.system ?? '';
    if (req.json) system += (system ? '\n\n' : '') + JSON_INSTRUCTION;

    const messages: Array<{ role: string; content: string }> = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: req.message });

    const tokens = maxTokens();
    const body: Record<string, unknown> = { model: req.model, messages, stream };
    if (tokens !== undefined) body.max_tokens = tokens;
    return { url, apiKey, body };
  }

  return {
    async complete(req: CompleteRequest): Promise<string> {
      const { url, apiKey, body } = requestParts(req, false);

      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`openai-compatible completion failed: ${res.status} ${detail}`);
      }

      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? '';
    },

    async stream(req: CompleteRequest, onText: (text: string) => void): Promise<string> {
      const { url, apiKey, body } = requestParts(req, true);
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`openai-compatible completion failed: ${res.status} ${detail}`);
      }
      if (!res.body) throw new Error('openai-compatible completion returned no stream body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let output = '';
      const consumeLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') return;
        const event = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const text = event.choices?.[0]?.delta?.content;
        if (text) {
          output += text;
          onText(text);
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) consumeLine(line);
        if (done) break;
      }
      if (buffer.trim()) consumeLine(buffer);
      return output;
    },
  };
}

export const openaiCompleter = createOpenAICompleter();
