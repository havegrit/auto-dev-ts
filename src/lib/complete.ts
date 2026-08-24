import { getCompleter } from '../llm/registry.js';
import { modelConfig } from './model-config.js';

export interface CompleteOptions {
  system?: string;
  message: string;
  json?: boolean;
  model?: string;
  signal?: AbortSignal;
}

function resolvedRequest(opts: CompleteOptions) {
  const model = opts.model ?? modelConfig.getModel();
  const providerModel = model.includes(':') ? model.slice(model.indexOf(':') + 1) : model;
  return {
    completer: getCompleter(model),
    request: {
      system: opts.system,
      message: opts.message,
      json: opts.json,
      model: providerModel,
      signal: opts.signal,
    },
  };
}

/**
 * 활성 프로바이더로 단발성 텍스트를 생성합니다. 도구 없이 한 턴만 돌립니다.
 * 모델 미지정 시 modelConfig의 현재 선택을 사용합니다.
 */
export async function complete(opts: CompleteOptions): Promise<string> {
  const { completer, request } = resolvedRequest(opts);
  return completer.complete(request);
}

/** 프로바이더가 지원하면 실제 델타를, 아니면 최종 결과 한 덩어리를 전달한다. */
export async function completeStream(opts: CompleteOptions, onText: (text: string) => void): Promise<string> {
  const { completer, request } = resolvedRequest(opts);
  if (completer.stream) return completer.stream(request, onText);
  const text = await completer.complete(request);
  if (text) onText(text);
  return text;
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
