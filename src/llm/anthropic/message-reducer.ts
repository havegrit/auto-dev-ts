import type { AgentEvent, AgentRunOutcome } from '../types.js';

export interface OutcomeAccumulator {
  tokensIn: number;
  tokensOut: number;
}

export function newAccumulator(): OutcomeAccumulator {
  return { tokensIn: 0, tokensOut: 0 };
}

/**
 * SDK 메시지 하나를 처리한다. 스트리밍 이벤트는 onEvent로 흘려보내고,
 * 'result' 메시지일 때만 최종 AgentRunOutcome을 반환한다(그 외에는 null).
 * msg는 SDK 미타입 메시지라 any로 받는다.
 */
export function reduceMessage(
  msg: any,
  // _acc는 미래의 스트리밍 누적 usage 집계를 위해 예약된 파라미터이며, 현재는 result 메시지의 usage를 직접 읽으므로 변경하지 않는다.
  _acc: OutcomeAccumulator,
  onEvent: (e: AgentEvent) => void,
): AgentRunOutcome | null {
  if (msg.type === 'assistant') {
    for (const block of (msg.message?.content ?? [])) {
      if (block.type === 'text' && block.text?.trim()) {
        onEvent({ kind: 'text', text: block.text.trim() });
      } else if (block.type === 'tool_use') {
        const input = typeof block.input === 'object'
          ? JSON.stringify(block.input)
          : String(block.input ?? '');
        onEvent({ kind: 'tool_call', name: block.name, input });
      }
    }
    return null;
  }

  if (msg.type === 'tool_result') {
    const content = Array.isArray(msg.content)
      ? msg.content.map((c: any) => c.text ?? '').join('')
      : String(msg.content ?? '');
    if (content.trim()) onEvent({ kind: 'tool_result', content });
    return null;
  }

  if (msg.type === 'rate_limit_event') {
    const info = msg.rate_limit_info;
    if (info?.status === 'rejected') {
      onEvent(info.resetsAt != null ? { kind: 'rate_limit', resetsAt: info.resetsAt } : { kind: 'rate_limit' });
    }
    return null;
  }

  if (msg.type === 'system' && msg.subtype === 'api_retry' && msg.error_status === 429) {
    onEvent(msg.retry_delay_ms != null ? { kind: 'rate_limit', retryDelayMs: msg.retry_delay_ms } : { kind: 'rate_limit' });
    return null;
  }

  if (msg.type === 'result') {
    const tokensIn = msg.usage?.input_tokens ?? 0;
    const tokensOut = msg.usage?.output_tokens ?? 0;
    const numTurns = msg.num_turns ?? 0;
    const stopReason = msg.stop_reason ?? null;

    if (msg.subtype === 'success') {
      return { status: 'success', output: msg.result ?? '', tokensIn, tokensOut, numTurns, stopReason };
    }
    const errorType = msg.subtype ?? 'error_unknown';
    const errors: string[] = Array.isArray(msg.errors) ? msg.errors : [];
    const permissionDenials: string[] = (msg.permission_denials ?? []).map((d: any) => d.tool_name ?? String(d));
    const output = [
      `[${errorType}]`,
      errors.length > 0 ? errors.join('\n') : '',
      permissionDenials.length > 0 ? `Permission denied: ${permissionDenials.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    return { status: 'error', output, tokensIn, tokensOut, numTurns, stopReason, errorType, permissionDenials, errors };
  }

  return null;
}
