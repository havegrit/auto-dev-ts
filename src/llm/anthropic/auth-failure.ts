const ANSI_ESCAPE = /\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

/**
 * Claude CLI/SDK가 인증 실패를 result success로 감싸 반환하는 알려진 응답인지 판정한다.
 * 전체 출력이 인증 안내 자체일 때만 true라서, 정상 작업 결과에서 login을 언급한 경우는
 * 실패로 오인하지 않는다.
 */
export function isAnthropicAuthFailure(output: unknown): boolean {
  const normalized = String(output ?? '')
    .replace(ANSI_ESCAPE, '')
    .trim()
    .replace(/\s+/g, ' ');

  return /^(?:not logged in(?:\s*[·•:\-]\s*please run\s+\/login)?|please run\s+\/login)$/i.test(normalized);
}
