import { query } from '@anthropic-ai/claude-agent-sdk';
import { modelConfig } from './model-config.js';

export interface CompleteOptions {
  system?: string;
  message: string;
  json?: boolean;
  model?: string;
}

/**
 * Claude 구독(Agent SDK 인증)으로 단발성 텍스트를 생성합니다.
 * 도구 없이 한 턴만 돌려 모델 응답 텍스트를 반환합니다. (API 키/과금 불필요)
 */
export async function complete(opts: CompleteOptions): Promise<string> {
  let system = opts.system ?? '';
  if (opts.json) {
    system += (system ? '\n\n' : '') +
      '반드시 유효한 JSON 객체 하나만 출력하세요. 코드펜스(```)나 설명 문구 없이 JSON만 반환하세요.';
  }

  let output = '';
  for await (const msg of query({
    prompt: opts.message,
    options: {
      ...(system ? { systemPrompt: system } : {}),
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      model: opts.model ?? modelConfig.getModel(),
    },
  })) {
    const m = msg as any;
    if (m.type === 'result') {
      if (m.subtype === 'success') {
        output = m.result ?? '';
      } else {
        throw new Error(`completion failed: ${m.subtype ?? 'unknown'}`);
      }
    }
  }
  return output;
}

/** 모델이 코드펜스나 설명을 섞어도 첫 JSON 객체를 추출해 파싱합니다. */
export function parseJsonLoose(text: string): any {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}
