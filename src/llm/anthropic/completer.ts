import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Completer, CompleteRequest } from '../types.js';

export const anthropicCompleter: Completer = {
  async complete(req: CompleteRequest): Promise<string> {
    let system = req.system ?? '';
    if (req.json) {
      system += (system ? '\n\n' : '') +
        '반드시 유효한 JSON 객체 하나만 출력하세요. 코드펜스(```)나 설명 문구 없이 JSON만 반환하세요.';
    }

    let output = '';
    for await (const msg of query({
      prompt: req.message,
      options: {
        ...(system ? { systemPrompt: system } : {}),
        allowedTools: [],
        permissionMode: 'bypassPermissions',
        ...(req.model ? { model: req.model } : {}),
      },
    } as any)) {
      const m = msg as any;
      if (m.type === 'result') {
        if (m.subtype === 'success') output = m.result ?? '';
        else throw new Error(`completion failed: ${m.subtype ?? 'unknown'}`);
      }
    }
    return output;
  },
};
