module.exports = {
  forbidden: [
    {
      name: 'store-does-not-import-higher-layers',
      comment: '저장 계층은 persistence를 소유하며 상위 application orchestration에 의존하지 않는다.',
      severity: 'error',
      from: { path: '^src/store/' },
      to: { path: '^src/(workflows|agents|server|schedule|integrations)/' },
    },
    {
      name: 'lib-does-not-import-application-layers',
      comment: '공용 라이브러리는 workflow, server, schedule보다 낮은 계층에 둔다.',
      severity: 'error',
      from: { path: '^src/lib/' },
      to: { path: '^src/(workflows|server|schedule)/' },
    },
    {
      name: 'lib-does-not-import-agents',
      comment: '공용 라이브러리는 에이전트 계층에 의존하지 않는다.',
      severity: 'error',
      from: { path: '^src/lib/(?!auto-merge-policy\\.ts$)' },
      to: { path: '^src/agents/' },
    },
    {
      name: 'auto-merge-policy-only-reads-agent-specs',
      comment: 'auto-merge-policy의 정책 예외는 AGENT_SPECS가 선언된 파일 하나로 제한한다.',
      severity: 'error',
      from: { path: '^src/lib/auto-merge-policy\\.ts$' },
      to: { path: '^src/agents/(?!specs\\.ts$)' },
    },
    {
      name: 'llm-does-not-import-application-layers',
      comment: 'LLM provider adapter는 저장소와 application orchestration에서 분리한다.',
      severity: 'error',
      from: { path: '^src/llm/' },
      to: { path: '^src/(store|workflows|agents|server)/' },
    },
    {
      name: 'agents-do-not-import-application-layers',
      comment: 'agent는 workflow가 호출하며 workflow나 server를 역호출하지 않는다.',
      severity: 'error',
      from: { path: '^src/agents/' },
      to: { path: '^src/(workflows|server)/' },
    },
    {
      name: 'no-circular-dependencies',
      comment: '순환 import는 초기화 순서와 소유 경계를 불분명하게 만든다.',
      severity: 'error',
      from: { path: '^src/' },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
