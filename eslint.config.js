import tseslint from 'typescript-eslint';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      // 누락된 await는 workflow 상태와 실제 작업 순서를 어긋나게 만든다.
      '@typescript-eslint/no-floating-promises': 'error',
      // Promise를 동기 callback 자리에 전달하면 호출자가 완료를 기다리지 못한다.
      '@typescript-eslint/no-misused-promises': 'error',
      // 새 상태가 추가되면 모든 분기에서 처리하도록 강제한다.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // 코드베이스의 함수형 스타일 규칙을 AST 수준에서 검사한다.
      'no-restricted-syntax': ['error', {
        selector: 'ClassDeclaration',
        message: 'Use functions and closures instead of class declarations.',
      }],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/cli.ts'],
    rules: {
      // 애플리케이션 출력은 직접 console 대신 구조화 logger를 사용한다.
      'no-console': 'error',
    },
  },
];
