import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Completer, CompleteRequest } from '../types.js';
import { createStderrCollector, withStderr } from './cli-stderr.js';

export const anthropicCompleter: Completer = {
  async complete(req: CompleteRequest): Promise<string> {
    let system = req.system ?? '';
    if (req.json) {
      system += (system ? '\n\n' : '') +
        '반드시 유효한 JSON 객체 하나만 출력하세요. 코드펜스(```)나 설명 문구 없이 JSON만 반환하세요.';
    }

    const cli = createStderrCollector();
    let output = '';
    try {
      for await (const msg of query({
        prompt: req.message,
        options: {
          ...(system ? { systemPrompt: system } : {}),
          allowedTools: [],
          permissionMode: 'bypassPermissions',
          stderr: cli.onStderr,
          ...(req.model ? { model: req.model } : {}),
        },
      } as any)) {
        const m = msg as any;
        if (m.type === 'result') {
          if (m.subtype === 'success') output = m.result ?? '';
          else throw new Error(`completion failed: ${m.subtype ?? 'unknown'}`);
        }
      }
    } catch (err) {
      throw withStderr(err, cli.text());
    }
    return output;
  },

  async stream(req: CompleteRequest, onText: (text: string) => void): Promise<string> {
    let system = req.system ?? '';
    if (req.json) {
      system += (system ? '\n\n' : '') +
        '반드시 유효한 JSON 객체 하나만 출력하세요. 코드펜스(```)나 설명 문구 없이 JSON만 반환하세요.';
    }

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    if (req.signal?.aborted) abortController.abort();
    else req.signal?.addEventListener('abort', onAbort, { once: true });

    const cli = createStderrCollector();
    let streamed = '';
    let result = '';
    try {
      for await (const msg of query({
        prompt: req.message,
        options: {
          ...(system ? { systemPrompt: system } : {}),
          allowedTools: [],
          permissionMode: 'bypassPermissions',
          stderr: cli.onStderr,
          includePartialMessages: true,
          abortController,
          ...(req.model ? { model: req.model } : {}),
        },
      } as any)) {
        const m = msg as any;
        if (m.type === 'stream_event'
          && m.event?.type === 'content_block_delta'
          && m.event.delta?.type === 'text_delta'
          && typeof m.event.delta.text === 'string') {
          streamed += m.event.delta.text;
          onText(m.event.delta.text);
        } else if (m.type === 'result') {
          if (m.subtype !== 'success') throw new Error(`completion failed: ${m.subtype ?? 'unknown'}`);
          result = m.result ?? '';
        }
      }
    } catch (err) {
      if (req.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      throw withStderr(err, cli.text());
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }

    // 일부 SDK/모델은 partial event 없이 result만 보낼 수 있다.
    if (!streamed && result) onText(result);
    return result || streamed;
  },
};
