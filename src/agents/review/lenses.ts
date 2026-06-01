export const LENSES = [
  { name: 'correctness', description: '코드 정확성·논리 오류·엣지 케이스 검토. 심각도(BLOCKER/HIGH/MEDIUM/LOW)와 파일·라인 포함한 findings 출력.' },
  { name: 'security',    description: '보안 취약점(주입, 인증, 노출 시크릿 등) 검토. 심각도(BLOCKER/HIGH/MEDIUM/LOW)와 파일·라인 포함한 findings 출력.' },
  { name: 'perf',        description: '성능 병목·비효율 쿼리·메모리 누수 검토. 심각도(BLOCKER/HIGH/MEDIUM/LOW)와 파일·라인 포함한 findings 출력.' },
  { name: 'style',       description: '코드 스타일·가독성·네이밍·문서화 검토. 심각도(MEDIUM/LOW)와 파일·라인 포함한 findings 출력.' },
];
