# auto-dev-ts

Claude Agent SDK 기반 개발 자동화 오케스트레이터. TypeScript ESM, Node ≥24, SQLite(better-sqlite3), Hono.

## 명령어

| 목적 | 명령 |
|---|---|
| 테스트 | `npm test` (vitest run) |
| 타입 체크 | `npx tsc --noEmit` |
| 정적 검사 | `npm run lint`, `npm run arch`, `npm run size-budget` |
| 단일 에이전트 | `./run scaffold\|test\|review\|cicd\|planner\|clarifier <input>` |
| 스펙 워크플로 | `./run spec <file>` |
| 서버 / 데몬 | `./run serve`, `./run daemon` |
| 이슈 연동 | `./run issues`, `./run work <key>` |

## 디렉터리 지도

| 위치 | 역할 |
|---|---|
| `src/workflows/spec.ts` / `team.ts` | `runSpec()` 단계 루프, TEAM_PLAN DAG, 워크트리·integrator |
| `src/workflows/from-issue.ts` | 이슈 → 스펙 변환 후 `runSpec` 호출 |
| `src/agents/specs.ts` | `AGENT_ORDER`, `AGENT_SPECS` — 역할 경계의 단일 진실 공급원 |
| `src/agents/dispatch.ts` `buildOptions()` / `project-context.ts` | 프롬프트 조립 + 프로젝트 컨텍스트(16 KiB 상한) |
| `src/agents/review/lenses.ts` | review 병렬 렌즈 서브에이전트 |
| `src/llm/` | 프로바이더 seam (`anthropic` / `codex` / `openai`), `registry.ts` |
| `src/lib/` | 워크스페이스, 취소, 설정·검증·역할 경계 유틸리티 |
| `src/lib/{project-config,verify,role-boundary}.ts`, `src/workflows/verify-gate.ts` | 결정적 검증 게이트 — `.auto-dev/project.json`이 있을 때만 동작 (ARCHITECTURE §6.2.1) |
| `src/lib/run-cancellation.ts` | 실행 취소 |
| `src/store/` | `schema.sql`, `runs.ts`(`agent_run`), `run-events.ts`(`agent_run_event`) |
| `src/server/`, `static/` | HTTP API + 대시보드 |
| `src/schedule/briefing.ts` | 일일 브리핑 cron |
| `prompts/*.system.md`, `docs/ARCHITECTURE.md` | 에이전트 프롬프트와 상세 설계 |

`src/store/run-repairs.ts`는 실패한 run 레코드를 보정하는 DB 유지보수 코드다. 라우팅 이력이 아니다.

## 코드 규칙

- import 경로에 `.js` 확장자를 붙인다 (ESM).
- 주석과 문서는 한국어로 쓴다.
- 테스트는 대상과 같은 디렉터리에 `*.test.ts`로 둔다.
- 테스트에서 실제 LLM을 호출하지 않는다. `src/workflows/spec.test.ts`의 `vi.mock` 패턴을 따른다.
- 역할 경계(도구 권한)는 `AGENT_SPECS.tools`에서만 바꾼다. 프롬프트로 권한을 흉내 내지 않는다.
- 마커 계약(`[TESTS: …]`, `[VERDICT: …]`, `[ROUTE: …]`)을 바꾸면 **파싱 함수 · 해당 프롬프트 · 테스트**를 같은 커밋에서 함께 고친다.
- 대상 프로젝트에 `.auto-dev/` 설정이 없으면 기존과 완전히 동일하게 동작해야 한다(하위 호환).
- 수정하지 않는다: Claude OAuth 흐름(`src/lib/claude-auth.ts`), OpenClaw 연동, 기본 bind 주소(`127.0.0.1`).
- 함수형 스타일(클래스 없음)과 기존 네이밍을 따른다. 이유는 `docs/ARCHITECTURE.md` §17.

## 완료 전 체크리스트

1. `npm test` 통과
2. `npx tsc --noEmit` 통과
3. `npm run lint`, `npm run arch`, `npm run size-budget` 통과
4. 새로 생긴 분기마다 테스트 추가
5. 동작이 바뀌었다면 `docs/ARCHITECTURE.md`와 `README.md`, `README.ko.md` 갱신
6. 보고 형식: 변경 요약 / 변경 파일 / 테스트 결과 / 남은 이슈와 질문

## 진행 중인 계획

`docs/plans/auto-dev-trust-roadmap.md` — 신뢰 측정 로드맵. 한 번에 한 Phase만, Phase당 브랜치 하나(`feat/phase-N-<slug>`), 끝나면 멈추고 승인을 받는다.
