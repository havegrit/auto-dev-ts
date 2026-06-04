import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

export const LENSES: Record<string, AgentDefinition> = {
  correctness: {
    description: '코드 정확성·논리 오류·엣지 케이스 검토. 심각도(BLOCKER/HIGH/MEDIUM/LOW)와 파일·라인 포함한 findings 출력.',
    prompt: '당신은 코드 정확성 리뷰어입니다. 논리 오류, 엣지 케이스 누락, 버그를 찾아 BLOCKER/HIGH/MEDIUM/LOW 심각도와 파일명·라인번호를 포함해 보고하세요.',
  },
  security: {
    description: '보안 취약점(주입, 인증, 노출 시크릿 등) 검토. 심각도(BLOCKER/HIGH/MEDIUM/LOW)와 파일·라인 포함한 findings 출력.',
    prompt: '당신은 보안 리뷰어입니다. SQL/명령어 주입, 인증·권한 결함, 시크릿 노출, OWASP Top 10을 검토해 BLOCKER/HIGH/MEDIUM/LOW 심각도와 파일명·라인번호를 포함해 보고하세요.',
  },
  perf: {
    description: '성능 병목·비효율 쿼리·메모리 누수 검토. 심각도(BLOCKER/HIGH/MEDIUM/LOW)와 파일·라인 포함한 findings 출력.',
    prompt: '당신은 성능 리뷰어입니다. N+1 쿼리, 불필요한 루프, 메모리 누수, 블로킹 I/O를 찾아 BLOCKER/HIGH/MEDIUM/LOW 심각도와 파일명·라인번호를 포함해 보고하세요.',
  },
  style: {
    description: '코드 스타일·가독성·네이밍·문서화 검토. 심각도(MEDIUM/LOW)와 파일·라인 포함한 findings 출력.',
    prompt: '당신은 코드 스타일 리뷰어입니다. 네이밍, 가독성, 중복, 주석·문서화 부족을 검토해 MEDIUM/LOW 심각도와 파일명·라인번호를 포함해 보고하세요.',
  },
};
