import type { AgentEvent } from '../types.js';
import { extractJsonObject } from './output.js';

/**
 * `codex exec --json` 이 stdout 으로 흘리는 JSONL 이벤트를 누적·해석한다.
 * 한 줄이 들어올 때마다 라이브로 흘려보낼 AgentEvent 목록을 만들고,
 * 최종 결과 조립에 필요한 상태(마지막 메시지·토큰 usage)를 모은다.
 */
export interface CodexStreamState {
  /** agent_message 텍스트들(순서대로). 마지막이 최종 응답(JSON 계약)일 확률이 높다. */
  messages: string[];
  tokensIn: number;
  tokensOut: number;
}

export function newCodexStreamState(): CodexStreamState {
  return { messages: [], tokensIn: 0, tokensOut: 0 };
}

/** 에이전트의 최종 응답 텍스트(계약 JSON 추출 대상). 없으면 빈 문자열. */
export function resultText(state: CodexStreamState): string {
  return state.messages.length > 0 ? state.messages[state.messages.length - 1] : '';
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function foldItem(item: any, state: CodexStreamState): AgentEvent[] {
  if (!item || typeof item !== 'object') return [];
  switch (item.type) {
    case 'agent_message': {
      const text = String(item.text ?? '').trim();
      if (!text) return [];
      state.messages.push(text);
      // 최종 응답이 JSON 계약이면 raw JSON 대신 summary 를 라이브로 보여준다.
      const parsed = extractJsonObject(text);
      const live = parsed?.summary ? String(parsed.summary) : text;
      return [{ kind: 'text', text: live }];
    }
    case 'reasoning': {
      const text = String(item.text ?? '').trim();
      return text ? [{ kind: 'text', text }] : [];
    }
    case 'command_execution': {
      const command = String(item.command ?? '').trim();
      const events: AgentEvent[] = [];
      if (command) events.push({ kind: 'tool_call', name: 'shell', input: command });
      const out = String(item.aggregated_output ?? item.output ?? '').trim();
      const exit = item.exit_code;
      if (out || exit != null) {
        events.push({ kind: 'tool_result', content: `${exit != null ? `[exit ${exit}] ` : ''}${truncate(out, 400)}` });
      }
      return events;
    }
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const files = changes.map((c: any) => String(c?.path ?? '')).filter(Boolean);
      return files.length ? [{ kind: 'tool_call', name: 'edit', input: files.join(', ') }] : [];
    }
    case 'mcp_tool_call': {
      const label = [item.server, item.tool].filter(Boolean).join('.');
      return label ? [{ kind: 'tool_call', name: label, input: '' }] : [];
    }
    case 'web_search': {
      const q = String(item.query ?? '').trim();
      return q ? [{ kind: 'tool_call', name: 'web_search', input: q }] : [];
    }
    case 'error': {
      const msg = String(item.message ?? item.text ?? '').trim();
      return msg ? [{ kind: 'text', text: `error: ${msg}` }] : [];
    }
    default:
      return [];
  }
}

/** 파싱된 JSONL 이벤트 객체 하나를 처리한다. */
export function foldCodexEvent(obj: any, state: CodexStreamState): AgentEvent[] {
  if (!obj || typeof obj !== 'object') return [];
  if (obj.type === 'turn.completed' && obj.usage) {
    state.tokensIn += Number(obj.usage.input_tokens ?? 0);
    state.tokensOut += Number(obj.usage.output_tokens ?? 0);
    return [];
  }
  // item.completed 만 처리한다. codex 는 각 단계가 끝날 때 이 이벤트를 흘리므로
  // 진행 상황이 단계별로 라이브 갱신된다. (started/updated 는 관측되지 않아 중복 위험만 있음)
  if (obj.type === 'item.completed') return foldItem(obj.item, state);
  return [];
}

/** stdout 한 줄(JSONL)을 관용적으로 파싱해 처리한다. 깨진 줄은 무시한다. */
export function foldCodexLine(line: string, state: CodexStreamState): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [];
  }
  return foldCodexEvent(obj, state);
}
