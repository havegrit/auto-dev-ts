# auto-dev 검증 중심 개선 로드맵

> Claude Code가 `auto-dev-ts` 저장소에서 순서대로 수행하기 위한 실행 계획이다.
> 시작 지시 예: "docs/plans/verification-roadmap.md의 작업 규칙을 읽고 Phase 0부터 진행해줘"

---

## 0. 작업 규칙 (Claude Code 필독)

- **한 번에 한 Phase만 진행한다.** Phase 하나 = 브랜치 하나(`feat/phase-N-<slug>`). Phase가 끝나면 멈추고 보고한 뒤, 사람의 승인을 받고 다음 Phase로 넘어간다.
- **구현 전에 먼저 읽는다.** 각 Phase의 "읽을 파일"을 먼저 읽는다. 이 문서의 계획과 실제 코드가 다르면, 구현 전에 차이와 수정안을 짧게 보고한다.
- **하위 호환을 지킨다.** `.auto-dev/` 설정이 없는 프로젝트는 지금과 완전히 동일하게 동작해야 한다. 달라지는 것은 경고 이벤트 추가뿐이다.
- **기존 컨벤션을 따른다.**
  - TypeScript ESM이며 import 경로에 `.js` 확장자를 붙인다.
  - 주석은 한국어로 쓰고, 테스트는 `*.test.ts`로 같은 위치에 둔다.
  - 역할 경계의 단일 진실 공급원은 `src/agents/specs.ts`의 `AGENT_SPECS`다.
- **마커 계약을 바꿀 때는 세 곳을 함께 고친다.** `[TESTS: …]`, `[VERDICT: …]`, `[ROUTE: …]` 같은 계약을 바꾸면 파싱 함수, 해당 프롬프트, 테스트를 같은 커밋에서 수정한다.
- **테스트에서 실제 LLM을 호출하지 않는다.** `src/workflows/spec.test.ts`의 `vi.mock` 패턴을 따른다.
- **건드리지 않는다.** Claude OAuth 흐름(`src/lib/claude-auth.ts`), OpenClaw 연동, 기본 bind 주소(`127.0.0.1`)는 수정 대상이 아니다.
- **Phase 공통 완료 조건**
  - `npm test` 통과
  - `npx tsc --noEmit` 통과
  - 새 분기마다 테스트 추가
  - `docs/ARCHITECTURE.md`의 관련 절(§6.2, §10.4 등)과 `README.md`, `README.ko.md` 갱신
- **완료 보고 형식**: 변경 요약 / 변경 파일 / 테스트 결과 / 남은 이슈와 질문

---

## 1. 배경과 목표

**현재 상태.** 통과 판정이 LLM 출력의 마커(`[TESTS: PASS]`, `[VERDICT: SHIP]`)를 정규식으로 파싱한 자기 보고에 의존한다. 에이전트가 PASS라고 쓰면 실제로 테스트가 통과했는지와 무관하게 다음 단계로 넘어간다.

**목표.** "실제로 돌아가야 통과"로 바꾼다. 판정 근거를 오케스트레이터가 직접 관찰한 결과(종료 코드, 실행 증거)로 옮긴다.

**원칙**

1. 판정은 결정적 신호(exit code)를 우선하고, LLM 마커는 보조로만 쓴다.
2. 구현하는 주체와 검증하는 주체를 분리한다.
3. 반복되는 실패는 프롬프트를 보정해서 넘기지 않고, 규칙·스킬·테스트로 영구화한다.
4. 자율성은 신뢰가 측정된 뒤에 확장한다.

---

## 2. 코드 지형 (현재 구조)

| 위치 | 역할 |
|---|---|
| `src/workflows/spec.ts` `runSpec()` | 단계 루프, `routeTo()`, `parseTests()` / `parseVerdict()` / `parseRoute()`, `feedbackBlock()` |
| `src/agents/specs.ts` | `AGENT_ORDER`, `AGENT_SPECS`(SDK allowedTools = 권한 경계) |
| `src/agents/dispatch.ts` `buildOptions()` | 프롬프트 조립: `OUTPUT_STYLE_RULE + system + --- + input` |
| `src/lib/workspace.ts` | `resolveProjectDir()`, `listProjects()` |
| `src/workflows/team.ts` | TEAM_PLAN DAG, 워크트리 병렬 실행, integrator |
| `src/workflows/from-issue.ts` | 이슈를 스펙으로 바꾼 뒤 `runSpec` 호출 |
| `src/store/schema.sql`, `runs.ts`, `run-events.ts` | `agent_run`, `agent_run_event` 테이블 |
| `src/lib/run-cancellation.ts` | 실행 취소 |
| `src/schedule/briefing.ts` | 일일 브리핑 cron |
| `src/llm/anthropic/agent-runner.ts` | SDK 실행(`permissionMode: 'bypassPermissions'`) |

> 참고: `src/store/run-repairs.ts`는 실패한 run 레코드를 보정하는 DB 유지보수 코드다. 재작업(라우팅) 이력이 아니다.

---

## Phase 0 — 이 저장소용 CLAUDE.md

**목적.** 대상 프로젝트에 요구할 것을 auto-dev 자신에게 먼저 적용한다.

**작업.** 루트에 `CLAUDE.md`를 60줄 이내로 작성한다. 담을 내용은 다음과 같다.

- **명령어**: `npm test`, `npx tsc --noEmit`, `./run …`
- **디렉터리 지도**: 위 2절을 요약
- **규칙**: 0절의 작업 규칙 중 코드에 관한 것
- **완료 전 체크리스트**

**완료 조건.** 문서만 추가한다. 이후 Phase에서 같은 실수가 반복되면 이 파일에 규칙을 추가한다.

---

## Phase 1 — 결정적 검증 게이트 (최우선)

**목적.** test 단계의 PASS를 오케스트레이터가 직접 실행한 검증 명령의 종료 코드로 확정한다.

**읽을 파일**: `src/workflows/spec.ts`, `src/workflows/spec.test.ts`, `src/workflows/team.ts`, `src/lib/run-cancellation.ts`, `src/store/runs.ts`, `src/store/run-events.ts`, `prompts/test.system.md`

### 1-1. 프로젝트 설정 로더

신규 파일 `src/lib/project-config.ts`를 만든다. `<projectDir>/.auto-dev/project.json`을 읽어 검증하고, 파일이 없으면 `undefined`를 반환한다.

이 Phase에서 쓰는 필드는 `verify`와 `roleBoundary`뿐이다. `runtime`은 Phase 3에서 추가한다.

```json
{
  "version": 1,
  "verify": { "command": "./gradlew check", "timeoutMs": 900000 },
  "roleBoundary": {
    "testGlobs": ["src/test/**", "**/*.test.ts", "**/*Test.java", "tests/**"],
    "ignoreGlobs": []
  }
}
```

설정 파일이 잘못되었으면 조용히 무시하지 않는다. 설정 파일 경로와 원인을 담은 명확한 오류로 run을 실패시킨다.

### 1-2. 검증 실행기

신규 파일 `src/lib/verify.ts`에 다음 함수를 만든다.

```ts
runVerify(projectDir, cfg, { signal })
  → { exitCode, timedOut, durationMs, outputTail }
```

- **실행 방식**: `spawn('bash', ['-c', command], { cwd, detached: true, env: process.env })`
- **종료 처리**: 타임아웃이나 취소 시 프로세스 그룹 전체를 종료한다(`process.kill(-pid, 'SIGTERM')`, 유예 후 `SIGKILL`). 취소는 `run-cancellation.ts`와 연동한다.
- **출력 보관**: stdout과 stderr를 합쳐 마지막 200줄 또는 20KB만 보관한다.

### 1-3. spec 루프에 게이트 삽입 (`src/workflows/spec.ts`)

test 단계가 끝난 직후 다음 표대로 판정한다.

| test 마커 | verify 결과 | 처리 |
|---|---|---|
| PASS | exit 0 | review로 진행 |
| PASS | exit ≠ 0 또는 timeout | 마커를 무시하고, verify 출력 꼬리를 피드백으로 붙여 planner로 라우팅 |
| FAIL | 실행 안 함 | 기존 동작 유지 |
| BLOCKED | 실행 안 함 | 기존 동작 유지 |
| (설정 없음) | — | 기존 동작 유지 + `verify_not_configured` 경고 이벤트 |

구현 시 함께 처리할 것:

- **피드백 출처 타입 확장**: `feedbackBlock(fromStep: Step, …)`과 `routeTo()`는 출처 타입이 `Step`이라 `'verify'`를 표현할 수 없다. `type FeedbackSource = Step | 'verify' | 'role-boundary'`처럼 확장한다.
- **예산 소진 시 원인**: 라우트 예산이 소진되면 failure의 `cause`를 `'verify_failed'`로 한다.
- **team 경로**: `executeTeam` 결과도 통합이 끝난 뒤 review 전에 같은 게이트를 통과해야 한다.

### 1-4. 역할 경계 사후 검사

**배경.** test 에이전트도 `Bash`를 가지므로 프로덕션 소스를 수정하는 것이 물리적으로 가능하다. 지금은 프롬프트로만 막고 있다.

**검사 방법.** 이미 scaffold가 소스를 바꾼 상태에서 test가 실행되므로, 파일 이름 목록 비교로는 부족하다. 다음 순서로 검사한다.

1. test 단계 직전에 변경 파일과 미추적 파일의 **내용 해시 스냅샷**을 만든다.
2. test 단계 직후에 다시 스냅샷을 만들어 비교한다.
3. test 단계에서 새로 생기거나 내용이 바뀐 파일 중 `testGlobs`에도 `ignoreGlobs`에도 해당하지 않는 파일이 있으면, `cause: 'role_boundary_violation'`으로 실패 처리한다.

**주의할 점**

- 위반 파일을 되돌리지 않고 보고만 한다.
- `.git`이 없으면 검사를 건너뛰고 경고 이벤트를 남긴다.
- gitignore된 빌드 산출물은 자동으로 제외된다. 그 외 오탐은 `ignoreGlobs`로 처리한다.

### 1-5. 기록과 노출

- **기록**: verify 결과를 기존 스키마에 맞춰 남긴다. `agent_run`에 `agent_name='verify'` 행을 추가하고 `agent_run_event`에 이벤트를 남기는 방식을 권장한다. 스키마 변경이 필요하면 기존 마이그레이션 방식을 먼저 확인하고 보고한다.
- **노출**: 대시보드 워크플로 상세 화면에 verify 결과(종료 코드, 소요 시간, 출력 꼬리)를 표시한다.

### 1-6. 프롬프트 정리

- **`prompts/test.system.md` 정리**: 실제 도구(`Read`, `Write`, `Bash`)와 맞지 않는 legacy 설명(`runShell` 30초 타임아웃 등)을 정리한다. 다음 두 가지를 명시한다.
  - 최종 판정은 오케스트레이터의 verify 명령으로 내려진다.
  - PASS를 선언하기 전에 같은 명령을 직접 실행해야 한다.
- **verify 명령 주입**: scaffold와 test의 입력에 verify 명령을 넣는다. `inputFor()` 또는 dispatch 단계에서 처리한다.

### 1-7. 테스트 (필수)

- **project-config**: 정상, 파일 없음, 스키마 오류
- **verify**: exit 0, exit 1, 타임아웃, abort 시 프로세스 그룹 정리
- **spec**
  - 1-3 판정 표의 각 행
  - 예산 소진 시 `verify_failed`
  - 역할 경계 위반 시 실패
  - 설정이 없을 때 기존 테스트가 전부 그대로 통과
- **team**: 통합 후 게이트 실패 시 review로 진행하지 않음

> 후속 과제(이 Phase 범위 밖): 빈 워크스페이스에서 새 프로젝트를 만드는 스펙이라면 scaffold가 `project.json`도 함께 만들게 한다. Phase 2의 `init-project`와 연결된다.

---

## Phase 2 — 대상 프로젝트 컨텍스트 주입

**목적.** 범용 프롬프트 대신 대상 레포의 지식으로 일하게 한다. Lauren Tan의 "피처 맵"에 해당하는 백엔드 버전이다.

**읽을 파일**: `src/agents/dispatch.ts`, `src/llm/anthropic/agent-runner.ts`, `src/agents/review/lenses.ts`

**먼저 확인할 것.** Agent SDK가 cwd의 `CLAUDE.md`를 이미 로드하는지(`settingSources` 등) 확인하고 결과를 보고한다. 이미 로드된다면 중복 주입하지 않는다.

**작업**

- **컨텍스트 섹션 추가**: `buildOptions()`에 `## Project context` 섹션을 추가한다.
  - 내용: `<projectDir>/AGENTS.md`(없으면 `CLAUDE.md`)와 `<projectDir>/.auto-dev/feature-map.md`
  - 상한: 합계 16KB. 넘으면 잘라내고 잘렸다는 표시를 남긴다.
  - 대상: planner, scaffold, test, review(렌즈 포함). clarifier에는 feature-map만 넣는다.
- **템플릿 추가**: 백엔드 기준 `docs/templates/feature-map.md`를 추가한다. 담을 항목은 다음과 같다.
  - 서비스 실행과 종료 방법
  - 주요 엔드포인트와 샘플 요청(curl)
  - 데이터 확인 방법(DB 쿼리, Kafka 토픽 소비 명령)
  - 패키지 구조와 의존 방향 규칙
  - 금지 패턴
- **(선택) `./run init-project <project>`**: 코드베이스를 탐색해 `AGENTS.md`, `.auto-dev/feature-map.md`, `.auto-dev/project.json` 초안을 만드는 에이전트를 추가한다.
  - 쓰기는 `.auto-dev/`와 `AGENTS.md`에만 허용한다.
  - 실행 전후 diff로 이 제약을 검사한다.
  - 결과는 사람이 검토한 뒤 커밋한다.

**테스트**: 컨텍스트가 있을 때, 없을 때, 상한을 넘을 때의 프롬프트 조립 결과

---

## Phase 3 — 실제 실행 검증과 독립 검증자

**목적.** 유닛 테스트를 넘어, 실제로 서비스를 띄우고 동작을 관찰한 증거로 판정한다.

### 3-1. 런타임 설정 확장

`project.json`에 `runtime` 필드를 추가한다.

```json
"runtime": {
  "up": "docker compose up -d --wait",
  "down": "docker compose down -v",
  "healthcheck": { "url": "http://localhost:8080/actuator/health", "timeoutMs": 120000 },
  "checks": [".auto-dev/checks/smoke.sh"]
}
```

- **병렬 충돌 방지**: 워크트리끼리 충돌하지 않도록 `COMPOSE_PROJECT_NAME=autodev-<runId 앞 8자리>`를 환경변수로 주입한다. 포트를 compose 파일에서 변수화하는 방법은 가이드로 문서화한다.
- **정리 보장**: `down`은 성공, 실패, 취소와 무관하게 `finally`에서 실행한다.

### 3-2. 오케스트레이터 소유 verify 단계

**실행 순서**

1. test
2. Phase 1 게이트
3. runtime up
4. healthcheck
5. checks 스크립트(결정적)
6. verifier 에이전트
7. runtime down
8. review

**배치 원칙.** planner의 PLAN 계약(`scaffold|test|review|cicd`)과 `AGENT_ORDER`는 바꾸지 않는다. verify는 planner가 배정하지 않는 내부 단계로 둔다. `checking-docs-before-commit`처럼 `AGENT_ORDER` 밖에 spec을 등록한다.

**verifier 에이전트**

- 컨텍스트를 공유하지 않는 새 세션에서 실행한다. 도구는 `Read`와 `Bash`다.
- 스펙과 feature-map을 입력받는다. 이번 변경이 의도대로 동작하는지 실제 요청과 조회로 확인하고 증거를 남긴다.
- 출력 마커: `[VERIFY: PASS]`, `[VERIFY: FAIL]`, `[VERIFY: BLOCKED]`

**판정과 안전장치**

- 결정적 checks가 하나라도 실패하면 verifier 마커와 무관하게 FAIL이다.
- FAIL이면 증거를 피드백에 포함해 planner로 라우팅한다.
- verifier도 `Bash`로 파일을 바꿀 수 있다. 실행 전후 스냅샷이 달라지면 실패 처리한다(1-4와 같은 방식).

### 3-3. 증거 보관

- **저장**: `data/evidence/<workflowRunId>/`에 요청과 응답, 쿼리 결과, 로그 꼬리, verifier 리포트를 저장한다. 대시보드에서 열람할 수 있게 한다.
- **review 연계**: review 입력에 증거 요약을 붙인다. 렌즈들이 코드를 읽은 소감이 아니라 증거를 근거로 판정하게 하기 위해서다.

### 3-4. 테스트

runtime 명령은 모두 mock한다. 실제 docker를 호출하지 않는다. 다음 경우를 검증한다.

- up 실패
- healthcheck 타임아웃
- checks 실패
- verifier가 파일을 수정한 경우
- 취소 시에도 down이 호출되는지

---

## Phase 4 — 버그 모드: 재현 먼저

**목적.** "재현되던 게 이제 안 된다"는 완료 조건이 명확한 버그 처리부터 신뢰를 쌓는다.

**읽을 파일**: `src/workflows/from-issue.ts`, `src/integrations/issue-tracker/*`

**진입 조건.** `issue.type`이 버그 계열이면 버그 모드로 실행한다. 정확한 값 목록은 트래커 연동 코드와 실제 응답을 확인한 뒤 정하고, 대소문자는 무시한다.

**흐름**

1. **재현 테스트 작성**: test 에이전트에 버그 모드 지시를 준다. 프로덕션 코드는 수정하지 않고 재현 테스트만 작성하며, 실행 명령을 `[REPRO: <command>]` 마커로 출력한다.
2. **실패 확인**: 오케스트레이터가 그 명령을 실행해 실패하는 것을 확인하고 observed failure로 기록한다. Phase 1의 실행기를 재사용한다.
   - 명령이 통과해 버리면 BLOCKED로 끝낸다. `cause: 'not_reproduced'`와 함께 "이미 해결됐거나 재현 정보가 부족함" 리포트를 남기고, 이슈 상태는 그대로 둔다.
3. **수정**: planner를 거쳐 scaffold가 수정한다.
4. **재실행**: 같은 REPRO 명령을 다시 실행한다. 반드시 통과해야 한다.
5. **전체 검증**: Phase 1 verify(Phase 3 이후에는 런타임 검증 포함)를 거쳐 review로 간다.

**제약.** 재현 명령은 워크스페이스 안에서만 실행한다.

**테스트**: 재현 실패(처음부터 통과), 수정 후에도 실패, 정상 경로

---

## Phase 5 — 실패를 자산으로 (학습 루프)

**목적.** 같은 지적이 반복되면 규칙으로 승격할 후보를 자동으로 올린다.

### 5-1. 기계 판독 블록 추가

review 프롬프트에 다음 블록을 추가한다. 기존 마커 계약은 유지하고, 블록은 마커 앞에 둔다.

```
FINDINGS_JSON:
[{"severity":"high","category":"layering","rule_hint":"controller에서 repository 직접 호출 금지","file":"src/main/java/..."}]
END_FINDINGS.
```

### 5-2. 저장

- 신규 테이블 `review_finding`을 만든다. 컬럼: `id`, `run_id`, `workflow_run_id`, `project`, `severity`, `category`, `rule_hint`, `file`, `created_at`
- 블록 파싱에 실패해도 run을 실패시키지 않는다. 경고 이벤트만 남긴다.
- verify 실패와 역할 경계 위반도 같은 테이블에 기록한다. `category`는 `'verify'`, `'role-boundary'` 등으로 구분한다.

### 5-3. 집계와 노출

- 프로젝트별로 최근 14일간 `category + rule_hint` 빈도를 집계해 TOP N을 뽑는다.
- 결과를 `briefing.ts` 일일 브리핑과 대시보드의 "규칙화 후보" 섹션에 노출한다.

### 5-4. 승격 경로 (사람이 결정)

- **절차 문제**: 프롬프트나 대상 레포의 `AGENTS.md`에 규칙을 추가한다.
- **코드 패턴 문제**: 대상 레포의 하드 규칙(ArchUnit 테스트, Checkstyle, CI의 grep 체크)으로 만든다.
- **(선택)** 후보 옆에 "규칙 초안 스펙 만들기" 버튼을 두고, 누르면 일반 spec 파이프라인으로 실행한다.

---

## Phase 6 — auto-dev 자체 eval

**목적.** 프롬프트와 모델 변경의 효과를 감이 아니라 점수로 판단한다.

### 6-1. 디렉터리 구조

```
evals/
  cases/<case-id>/
    spec.md       # 입력 스펙 또는 버그 리포트
    fixture/      # 작은 대상 프로젝트 (또는 meta.json에 git URL + ref)
    checks.sh     # 정답 판정 (exit 0 = 통과)
    meta.json     # 태그, 기대 결과(SHIP / clarification 등), 타임아웃
```

### 6-2. 실행기

`./run eval [--case <id>] [--models a,b]` 명령을 추가한다.

1. fixture를 임시 디렉터리에 복사한다.
2. `runSpec`을 실행한다.
3. `checks.sh`로 정답 여부를 판정한다.
4. 결과를 기록한다: 통과 여부, routeCount, 토큰, 소요 시간, verdict
5. `data/evals/<timestamp>.json`에 저장하고, 직전 기준선과 비교한 요약을 출력한다.

### 6-3. 초기 케이스 (3~5개)

- **작은 TS 프로젝트**: 빠른 회귀 확인용
- **Spring Boot + Postgres 버그 1개**: Phase 4 재현 모드 검증용
- **모호한 스펙 1개**: clarifier가 올바르게 중단하는지 확인용

### 6-4. 운영 규칙

- **모델 매트릭스**: 기존 `agentModels` 런타임 설정을 run 단위로 오버라이드해 여러 모델을 비교한다.
- **기록과 비용**: eval run은 `triggerSource: 'eval'`로 기록하고 costGuard 일일 한도를 지킨다.
- **변경 절차**: `prompts/`를 바꾸는 PR에는 eval 전후 비교 결과를 첨부한다.

---

## Phase 7 — 자율성 확장 (설계 문서만, Phase 1~6 이후 구현)

이 Phase의 산출물은 `docs/superpowers/specs/`에 들어갈 설계 문서뿐이다. 구현은 별도 승인을 받는다.

- **재시작 내성**: 워크플로 상태(`cursor`, `routeCount`, `pendingFeedback`, `planOutput`)를 DB에 체크포인트하고, 서비스가 기동할 때 재개한다. 현재의 `server_restart` 실패 처리를 대체한다.
- **PR 출력**: 로컬 atomic commit 대신 브랜치를 push하고 `gh pr create`로 PR을 만든다. 본문에 verify 결과와 증거 링크를 넣는다.
- **자동 머지**: 저위험 범주(문서, 의존성 패치 등)에 한해서만 허용한다. eval과 실사용에서 연속 성공이 측정되어야 하고, 프로젝트 설정으로 명시적으로 opt-in해야 한다.

---

## 우선순위 요약

| Phase | 얻는 것 | 예상 규모 |
|---|---|---|
| 0 | 이후 작업의 품질 | 매우 작음 |
| 1 | 판정 근거가 자기 보고에서 종료 코드로 바뀜 | 작음~중간 |
| 2 | 대상 레포 맥락 반영 | 작음 |
| 3 | 실제 동작을 관찰한 증거 | 큼 |
| 4 | 버그 처리에 대한 신뢰 | 중간 |
| 5 | 개선이 쌓이는 구조 | 중간 |
| 6 | 개선 효과 측정 | 중간 |
| 7 | 무인 운영 | 큼 |
