import type { AgentRunner } from '../types.js';

/**
 * OpenAI 호환 프로바이더는 도구 실행 harness가 없다(맨몸 HTTP 모델).
 * 도구를 쓰는 agentic 실행은 아직 지원하지 않으므로 명확히 실패한다.
 * 순수 텍스트 생성은 completer 를 사용할 것.
 */
export const openaiAgentRunner: AgentRunner = {
  async run() {
    throw new Error(
      'openai-compatible provider does not support tool-using agent runs yet; use it for text completion only',
    );
  },
};
