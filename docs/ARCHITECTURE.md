# auto-dev-ts — 시스템 아키텍처 문서

> 본 문서는 현재까지 구현된 `auto-dev-ts` 의 **구조·동작 원리·설계 결정** 을 정리한
> 기술 문서입니다. 사용 방법은 [`README.md`](../README.md) /
> [`README.ko.md`](../README.ko.md) 를 참고하세요.
>
> auto-dev-ts 는 [auto-dev (Java)](https://github.com/havegrit/auto-dev) 를
> TypeScript 로 재작성한 버전입니다. LLM API 직접 호출 → **Claude Code SDK 위임** 으로
> 전환해 per-token 과금을 구독 플랜 비용으로 대체한 것이 핵심 변경점입니다.
>
> SDK 호출은 `src/llm/` **프로바이더 seam** 뒤로 격리되어 있어, 인증·과금 방식
> (구독 ↔ API)이나 프로바이더를 교체해도 상위 파이프라인은 영향받지 않습니다.
> 설계 배경은 [`docs/superpowers/specs/2026-06-19-llm-provider-abstraction-design.md`](superpowers/specs/2026-06-19-llm-provider-abstraction-design.md) 참고.

## 1. 개요

### 1.1 목적

개인 개발자 워크플로우 자동화. Java 버전과 목적은 동일하나, **운영 비용 구조**가
다르다:

| | auto-dev (Java) | auto-dev-ts (TypeScript) |
|---|---|---|
| LLM 호출 | OpenAI API 직접 → per-token 과금 | Claude Code SDK → 구독 플랜 내 포함 |
| API 키 | `OPENAI_API_KEY` 필수 | 불필요 (Claude Code 인증만) |
| 비용 회로차단기 | 일일 $5 USD 한도 | 일일 실행 횟수 100회 한도 |
| 에이전트 런타임 | LangChain4j AiServices | `query()` async generator |

### 1.2 현재 도달 수준

- ✅ 인프라 layer (트리거 다양화 / 영속화 / 실행 가드)
- ✅ Claude Code SDK 기반 에이전트 실행 (파일 I/O, 쉘 접근 내장)
- ✅ 병렬 멀티-렌즈 리뷰 (SDK `agents` 옵션)
- ✅ 작업별 동적 팀 DAG 실행 및 worktree 격리
- ✅ SpecWorkflow 파이프라인 (clarifier → planner → scaffold → test → review → cicd)
- ✅ 피드백 라우팅 (review/test 가 수정 필요 시 planner/clarifier 로 되돌려 재작업)
- ✅ HTTP API + 웹 대시보드
- ✅ SSE 라이브 이벤트 (`run-events` + `GET /api/runs/:id/events` — 실행 중 행 실시간 표시 + run 상세 펼치기)
- ✅ LLM 프로바이더 seam (`src/llm/` — 인증/프로바이더 교체 가능, §4.2)
- ✅ rate-limit 회로차단기 (`circuit-breaker` — 429/reset 감지 시 실행 차단)
- ✅ issue-tracker 연동 (`/api/issues`, `work <key>` — 이슈 조회 + 자동 처리)
- ✅ automation job client (idempotent create, lease claim/heartbeat, review/retry API)
- ✅ 프로젝트명 기반 워크스페이스 (경로 대신 프로젝트명 입력 → 루트 기준 해석)
- ✅ 단발성 LLM 프록시 (`POST /api/llm/complete` — 외부 정적 앱이 구독으로 생성)
- ✅ 플로팅 AI 채팅 (일반 채팅 + 안전한 프로젝트 Q&A + 브라우저 장기 기억 + NDJSON 스트리밍)
- ✅ OpenClaw Telegram bridge (기존 계정 수신 → 루프백 spec 실행 + 종료 알림)
- ⚠️ Planner 모드 (동적 plan 파싱) — 미구현 (고정 순서 + 라우팅 재진입)
- ⚠️ 브라우저 검증 (Playwright) — 미구현

현실적 자율 범위: **잘 정의된 좁은 task 한 건을 Claude Code 세션 1개로 처리** 수준.

---

## 2. 기술 스택

| 영역 | 선택 | 한 줄 근거 |
|---|---|---|
| 언어/런타임 | **TypeScript + Node.js 24** | Claude Code SDK 가 Node.js 기반 |
| LLM 런타임 | **Claude Code SDK (`@anthropic-ai/claude-agent-sdk`)** | Claude Code CLI 를 프로그래밍으로 제어, 구독 플랜 사용 |
| LLM 추상화 | **프로바이더 seam (`src/llm/`)** | SDK 호출을 `anthropic` 프로바이더로 격리 → 인증/프로바이더 교체 가능 (§4.2) |
| HTTP 서버 | **Hono + `@hono/node-server`** | 경량, Spring Boot 대비 오버헤드 없음 |
| CLI | **Commander v12** | Picocli 대응, Node.js 생태계 표준 |
| 영속화 | **better-sqlite3 v12** | 동기 API, 단일 사용자 / 파일 1개 |
| 스케줄러 | **node-cron v3** | `@Scheduled` 대응 |
| 빌드/실행 | **tsx (dev) + tsc (prod)** | TypeScript 직접 실행, Gradle 불필요 |

---

## 3. 큰 그림

```
                ┌──────────────────────────────────────────────────┐
                │  Triggers                                         │
                │  • CLI (Commander)   • HTTP API (POST /api/...)  │
                │  • node-cron         • OpenClaw Telegram skill    │
                └──────────────────────────┬───────────────────────┘
                                           ▼
                                 ┌──────────────────┐
                                 │   cli.ts / routes │── getAgent() ──► registry
                                 └────────┬─────────┘
                                          ▼
                         ┌──── runAgent() in lib/runner.ts ────┐
                         │ 1. costGuard.allow()?               │
                         │    NO  → insertRun(BLOCKED), return │
                         │ 2. insertRun(RUNNING)               │
                         │ 3. getAgentRunner().run(req, onEvt) │
                         │    └─ llm/registry → anthropic      │
                         │       provider → query()            │
                         │       ← @anthropic-ai/claude-agent-sdk │
                         │       ← Claude Code CLI subprocess  │
                         │ 4. collect AgentRunOutcome          │
                         │ 5. costGuard.recordRun()            │
                         │ 6. updateRun(DONE | FAILED)         │
                         └──────────────┬──────────────────────┘
                                        ▼
              ┌──────┬─────────┬────────┬──────┬──────────────┐
              ▼      ▼         ▼        ▼      ▼              ▼
          planner scaffold   test   review  cicd        clarifier

                                         │
                                         │  SDK agents[] fan-out (병렬)
                                         ▼
                               ┌───────────────────────┐
                               │ correctness sub-agent  │
                               │ security sub-agent     │
                               │ perf sub-agent         │
                               │ style sub-agent        │
                               └───────────────────────┘

  Each agent → getAgentRunner().run({ cwd, tools, model, effort }, onEvent)
                          │  (anthropic provider → query())
                          ▼
                ┌───────────────────────────┐
                │  Claude Code (CLI)         │
                │  • Read   (파일 읽기)      │
                │  • Write  (파일 쓰기)      │
                │  • Bash   (명령 실행)      │
                │  • Agent  (서브에이전트)   │
                └──────────────┬────────────┘
                               ▼
                        Filesystem + OS shell

       Cross-cutting:
       • costGuard          → 일일 실행 횟수 회로차단 (Asia/Seoul 자정 리셋)
       • SQLite agent_run   → 모든 호출 영속화
       • logger             → JSON 구조화 로그 (stdout/stderr)
```

---

## 4. 핵심 추상화

### 4.1 `runAgent()` — 공통 실행 파이프라인

Java 버전의 `AbstractAgent.run()` 에 대응. 클래스 상속 대신 **함수**로 구현.

```typescript
// src/lib/runner.ts
export async function runAgent(opts: RunOptions): Promise<RunResult>
```

| 단계 | 책임 |
|---|---|
| 1 | `costGuard.allow()` — 일일 한도 도달 시 BLOCKED 즉시 반환 |
| 2 | `insertRun(RUNNING)` — DB row 생성 + trigger 메타 |
| 3 | `getAgentRunner().run(req, onEvent)` — LLM seam 경유 (§4.2). 프로바이더가 SDK 호출을 담당 |
| 4 | `AgentRunOutcome` 수집 — output + token usage + stopReason. 스트리밍 이벤트는 `onEvent` 콜백으로 SSE/circuit-breaker 에 전달 |
| 5 | `costGuard.recordRun()` |
| 6 | `updateRun(DONE | FAILED)` — DB row 업데이트 |

에이전트 함수는 `runAgent()` 를 호출하기만 하면 됨 → 횡단 관심사 자동 적용.

Java 버전 대비 **제거된 책임**:
- 토큰 budget clamp (SDK 가 컨텍스트 관리)
- 429 재시도 (SDK 내부 처리)
- SSE 브로드캐스트 및 실행 이벤트 영속화 (`run-events` + `GET /api/runs/:id/events`)

### 4.2 LLM 프로바이더 seam (`src/llm/`)

`runner.ts` / `complete.ts` / `model-config.ts` 는 SDK 를 **직접** 부르지 않고
프로바이더-무관 인터페이스를 통해 호출한다. SDK·인증·과금 방식을 한 곳에 가두는
경계(seam)이며, 설계 배경은
[`docs/superpowers/specs/2026-06-19-llm-provider-abstraction-design.md`](superpowers/specs/2026-06-19-llm-provider-abstraction-design.md) 참고.

```typescript
// src/llm/types.ts — 세 가지 능력을 분리한 인터페이스
interface AgentRunner  { run(req, onEvent): Promise<AgentRunOutcome>; }  // 도구 쓰는 agentic 실행
interface Completer    { complete(req): Promise<string>; stream?(req, onText): Promise<string>; }
interface ModelCatalog { listModels(): Promise<ModelSpec[]>; }          // 모델 디스커버리
```

```typescript
// src/llm/registry.ts — AUTO_DEV_PROVIDER 로 활성 프로바이더 선택 (기본 anthropic)
export function getAgentRunner(): AgentRunner   // → 알 수 없는 provider 면 fail-fast
export function getCompleter(): Completer
export function getModelCatalog(): ModelCatalog
```

| 호출부 | 사용하는 능력 | 용도 |
|---|---|---|
| `lib/runner.ts` | `AgentRunner` | 에이전트 1회 실행 (clarifier~cicd) |
| `lib/complete.ts` | `Completer` | 단발성/스트리밍 텍스트 (`POST /api/llm/complete`, `POST /api/chat`) |
| `lib/chat.ts` / `lib/chat-context.ts` | `Completer` | 채팅 문맥 구성, 장기 기억 압축, 프로젝트 파일 필터·선택 |
| `lib/model-config.ts` | `ModelCatalog` | 대시보드 모델 목록 동적 로딩 + UI 저장 설정 적용 |
| `lib/app-config.ts` | JSON file | 대시보드에서 저장한 런타임 설정 (`AUTO_DEV_CONFIG_PATH`, 기본 `./data/config.json`) |

**anthropic 프로바이더 구현** (`src/llm/anthropic/`)이 실제 SDK 호출을 담당한다.
`agent-runner.ts` 는 `query()` 로 Claude Code CLI 를 subprocess 구동하고,
`message-reducer.ts` 가 SDK 메시지 스트림을 프로바이더-무관 `AgentEvent`
(`text` / `tool_call` / `tool_result` / `rate_limit`)와 `AgentRunOutcome` 으로 환원한다.
일부 SDK 버전은 Claude CLI 비로그인 응답(`Not logged in · Please run /login`)과
조직 구독 권한 거부 응답을 `result.subtype=success`로 전달하므로, reducer가 정확한
전체 출력 패턴을 검사해 `anthropic_auth_failed` 오류로 교정한다. 다른 fallback 모델이
설정돼 있으면 `lib/runner.ts`가 auth 실패에도 한 번 재시도한다. 서버 시작 시
`store/run-repairs.ts`도 같은 판정으로 과거 `DONE` child와 연결된 spec 부모를
`FAILED`로 한 번 교정한다.

```typescript
// src/llm/anthropic/agent-runner.ts (요지)
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const msg of query({ prompt, options: {
  allowedTools: req.tools,           // 역할 경계 (AGENT_SPECS.tools)
  permissionMode: 'bypassPermissions',
  cwd: req.cwd,
  model: req.model,
  ...(req.effort ? { effort: req.effort } : {}),  // 모델이 effort 미지원 시 생략
} })) { /* reduce → AgentEvent / AgentRunOutcome */ }
```

| `query()` 옵션 | 타입 | 설명 |
|---|---|---|
| `allowedTools` | `string[]` | 에이전트가 사용할 수 있는 도구 (`Read`, `Write`, `Bash`, `Agent`) |
| `permissionMode` | string | `bypassPermissions` — 모든 권한 승인 없이 자동 실행 |
| `cwd` | string | 에이전트 작업 디렉토리 (모든 파일 I/O 기준점) |
| `model` / `effort` | string | `modelConfig` 가 에이전트 역할별 기본 선호(clarifier=haiku, planner/test/cicd=sonnet, scaffold/review=opus)를 적용. UI 저장값과 env override가 우선하며 이후 `role preference` → `fallback` → `global/current` 순으로 해석 |
| `agents` | `{name, description}[]` | 서브에이전트 선언 (병렬 fan-out) |

> 새 프로바이더(예: API 키 기반 직접 호출)는 `src/llm/<name>/` 에 세 인터페이스를
> 구현하고 `registry.ts` 의 `PROVIDERS` 에 등록하면 된다. 상위 파이프라인 변경 불필요.

### 4.3 에이전트 레지스트리

```typescript
// src/agents/index.ts
const registry: Record<string, AgentFn> = {
  scaffold, review, test, cicd, planner, clarifier,
};

export function getAgent(name: string): AgentFn | undefined
export function listAgents(): string[]
```

Java `AgentRegistry` (Spring `Map<String, Agent>` 자동 수집) 대응.
DI 없이 단순 객체 맵으로 구현.

### 4.4 `costGuard` — 일일 실행 가드

Java 버전의 `DailyCostCircuitBreaker` 대응. 구독 플랜은 per-token 과금이 없으므로
**실행 횟수** 기준으로 런어웨이 자동화를 방지한다.

```typescript
// src/lib/cost-guard.ts
export const costGuard = {
  allow(): boolean   // 일일 한도 미초과 시 true
  recordRun(): void  // 실행 1회 카운트
  stats(): { count, limit, date }
}
```

- 기본 한도: 100회/일 (`AUTO_DEV_DAILY_RUN_LIMIT`)
- 타임존: `Asia/Seoul` — 자정 리셋
- DB 재시작 후 복원 없음 (메모리만). 재시작하면 카운터 0 리셋.

---

## 5. Agent 별 책임

### 5.0 구현 권한 정책 (역할 경계)

각 에이전트의 권한은 **"누가 코드를 구현하는가"** 기준으로 엄격히 분리된다.
이 경계는 (1) 코드의 `tools` 배열(하드 enforcement) 과 (2) 각 프롬프트의
`역할 경계` 섹션(행동 지침) 양쪽에 명시되어 있다.

| 에이전트 | tools | 파일 쓰기 | 구현 범위 |
|---|---|---|---|
| clarifier | `Read` | ❌ | 없음 — 질문/요약 JSON 출력만 |
| planner | `Read` | ❌ | 없음 — `PLAN:` step 목록 출력만 |
| **scaffold** | `Read, Write, Bash` | ✅ | **애플리케이션 소스 코드를 구현하는 유일한 에이전트** |
| test | `Read, Write, Bash` | ✅ (테스트 코드 한정) | 테스트 코드만. 프로덕션 소스 수정 금지 (버그는 보고만) |
| review | `Read` | ❌ | 없음 — 읽기 전용. blocker/high 도 수정안 제시만 |
| verifier | `Read, Bash` | ❌ (사후 검사) | 내부 단계. 실행 중인 서비스 동작을 관찰하고 증거를 보고 |
| cicd | `Read, Write` | ✅ (설정 파일 한정) | 파이프라인/Docker/배포 설정 파일만. 앱 소스 구현 금지 |
| checking-docs-before-commit | `Read, Write, Bash` | ✅ (문서 한정) | 성공 후 전역 스킬 지침으로 문서 stale 여부 점검·갱신. stage/commit 금지 |
| atomic-commit | `Read, Bash` | ❌ | 성공 후 spec 관련 hunk만 atomic commit. push/history rewrite/변경 폐기 금지 |

원칙:

- **애플리케이션 소스 코드 구현은 오직 scaffold.** 다른 단계는 절대 소스를 쓰지 않는다.
- **test 는 테스트 코드 작성이 예외로 허용**된다. 단 프로덕션 소스에 버그가 보이면
  직접 고치지 않고 `[TESTS: FAIL]` 로 보고 → 다음 iteration 의 scaffold 가 수정한다.
- **cicd 는 CI/CD 설정 파일(YAML/Dockerfile 등) 작성만** 허용된다. 이는 앱 "코드 구현"이
  아닌 인프라 설정으로 간주한다. 앱 소스 변경이 필요하면 scaffold 로 넘긴다.
- review/planner/clarifier 는 `Write` 권한 자체가 없어 물리적으로 파일을 쓸 수 없다.
- `verifier`는 `AGENT_ORDER` 밖의 내부 단계다. 새 실행 세션에서 `Read`, `Bash`를 쓰고,
  실행 전후 workspace 스냅샷으로 Bash를 통한 파일 변경을 탐지한다.
- 두 commit 후처리 에이전트는 `AGENT_ORDER` 밖의 내부 단계다. 일반 agent picker에는
  노출하지 않으며, core workflow 전체 성공 뒤에만 순서대로 호출한다.

### 5.0.1 대상 프로젝트 컨텍스트

`src/agents/dispatch.ts` 의 `buildOptions()` 는 프로젝트 작업 규칙과 feature map을
대상 역할의 입력에 `## Project context` 절로 붙인다. `planner`, `scaffold`, `test`,
`review` 는 `<cwd>/AGENTS.md` 가 있으면 이를 우선 사용하고,
`<cwd>/.auto-dev/feature-map.md` 도 함께 읽는다. `clarifier` 의 명시적 context 절에는
feature map만 넣는다. 내부 `verifier` 도 실제 동작 확인을 위해 feature map만 받는다.

두 파일의 합계는 UTF-8 기준 16 KiB 로 제한한다. 초과하면 경계가 깨지지 않게 자르고
프롬프트에 잘림 표시를 붙인다. 파일이 없으면 빈 context 절을 만들지 않는다. review의
네 렌즈에도 같은 context를 넣는다. feature map 작성 예시는
[`docs/templates/feature-map.md`](templates/feature-map.md) 참고.

Claude Agent SDK는 `settingSources` 를 별도로 지정하지 않으면 기본 소스를 읽으며,
`project` 소스가 cwd의 `CLAUDE.md`를 로드한다. 그래서 Anthropic 실행에서는 이 파일을
프롬프트에 중복 삽입하지 않는다. `AGENTS.md`가 없고 SDK가 이를 자동 로드하지 않는
provider에서는 `CLAUDE.md`를 명시적으로 넣는다.
Anthropic 실행의 clarifier도 SDK 기본 동작으로 `CLAUDE.md`를 읽을 수 있지만,
auto-dev가 추가하는 context 절에는 넣지 않는다.

### 5.1 clarifier

- **입력**: 스펙 전문 + 이전 Q&A (선택)
- **출력**: `{ ready: boolean, questions: string[] }` JSON
- 도구: `Read` (스펙 파일 참조)
- SpecWorkflow 첫 단계 — 불명확한 전제를 사전에 파악

### 5.2 planner

- **입력**: 스펙 전문
- **출력**: 구조화된 개발 계획 (자유 형식 — Java 버전의 `PLAN: ... END.` envelope 미구현)
- 도구: `Read` (thinking only, 실제 파일 쓰기 없음)
- 계획 출력이 SpecWorkflow 의 다음 단계 입력으로 전달됨

### 5.3 scaffold

- **입력**: 스펙 또는 플래너 출력
- **출력**: 생성된 파일 목록 + 설명
- 도구: `Read`, `Write`, `Bash`
- `cwd` 내에서 파일 생성·수정. SDK 가 `Write` 도구를 통해 실제 파일 I/O 처리

### 5.4 review (멀티-렌즈 오케스트레이터)

Java 버전과 동일한 fan-out 구조를 **SDK `agents` 옵션**으로 구현:

```typescript
// src/agents/review/index.ts
return runAgent({
  name: 'review',
  prompt: `${SYSTEM}\n\n---\n\n${input}`,
  tools: ['Read'],
  subagents: LENSES,   // 4개 lens 선언
});
```

```
                ┌──────────────────────────────┐
                │   review agent (orchestrator) │
                │   SDK agents[] 선언            │
                │   → Claude 가 병렬 fan-out     │
                └──────────────┬───────────────┘
                               │
     ┌──────────┬──────────────┴──────┬───────────┐
     ▼          ▼                     ▼           ▼
correctness  security               perf        style
```

Java 버전 대비 차이점:

| | Java | TypeScript |
|---|---|---|
| 병렬화 | `CompletableFuture` × bounded pool | SDK 내장 (선언만) |
| JSON finding 파싱 | `ReviewAgent` 직접 dedup + verdict | 미구현 (자유 형식 출력) |
| DB 행 | parent + 4 sub 각자 별도 row | 단일 review row |
| 타임아웃 | per-sub 90s | SDK 관리 |

#### 렌즈 정의 (`src/agents/review/lenses.ts`)

| lens | description (서브에이전트 역할 힌트) |
|---|---|
| `correctness` | 정확성·논리 오류·엣지 케이스 검토 |
| `security` | 보안 취약점 (주입, 인증, 노출 시크릿 등) 검토 |
| `perf` | 성능 병목·비효율 쿼리·메모리 누수 검토 |
| `style` | 코드 스타일·가독성·네이밍·문서화 검토 |

### 5.5 test

- 도구: `Read`, `Write`, `Bash` — **테스트 코드만** 작성 + 실행
- 테스트 코드 오류는 자기 실행 안에서 직접 수정한다. 프로덕션 소스 오류는 고치지 않고
  `[TESTS: FAIL]` + `[ROUTE: planner|clarifier]` 로 보고 → 오케스트레이터가 해당
  단계로 되돌려 scaffold 가 재구현 (§6.2, §10.3)
- `[TESTS: PASS]` 는 **자기 보고일 뿐 최종 판정이 아니다.** 대상 프로젝트가
  `.auto-dev/project.json` 에 `verify` 를 선언했으면 오케스트레이터가 그 명령을 직접
  실행해 종료 코드로 확정한다 (§6.2.1)
- 테스트 경로 밖의 파일을 수정했는지 실행 전후 내용 해시로 사후 검사한다 (§6.2.1)

### 5.6 cicd

- 도구: `Read`, `Write` (`Bash` 없음 — 실제 배포/빌드 명령 실행 불가)
- 기본은 CI-first: GitHub Actions YAML, Dockerfile, 빌드/테스트/검증 설정 파일 생성
- 배포 manifest / 릴리스 스크립트는 CD 의도가 명시된 경우에만 추가
- 애플리케이션 소스 코드는 구현하지 않는다 (scaffold 전용)

---

## 6. 워크플로우 오케스트레이션 (`SpecWorkflow`)

### 6.1 진입

```typescript
// src/workflows/spec.ts
export async function runSpec(specContent: string, opts: SpecOptions): Promise<SpecResult>
```

### 6.2 시퀀스 + 피드백 라우팅 모드

기본 순서는 `clarifier → planner → scaffold → test → review → cicd` 의 선형
시퀀스다. 단, **review/test 가 수정이 필요하다고 판단하면 planner 또는 clarifier 로
즉시 되돌아가** 재작업한다 (커서 기반 재진입):

```
cursor = 0
while cursor < len(STEP_ORDER):
    step = STEP_ORDER[cursor]
    result = await agent(step)(inputFor(step) + pendingFeedback)
    if step == 'clarifier' and ready == false:
        verdict = NEEDS-CLARIFICATION; break
    if step == 'planner':
        if invalid PLAN contract: verdict = BLOCKED; break
        planOutput = result.output

    # test 직후: 역할 경계 사후 검사 (테스트 경로 밖 변경 = 즉시 실패)
    if step == 'test' and roleBoundary violated: verdict = FAILED; break

    # test: 소스 코드 오류로 판정된 FAIL 만 되돌린다 (테스트 코드 오류는 test 가 직접 수정)
    if step == 'test' and missing [TESTS: ...]: verdict = BLOCKED; break
    if step == 'test' and parseTests == FAIL and [ROUTE: planner|clarifier]:
        cursor = index(route); pendingFeedback = result; continue

    # test PASS: 오케스트레이터가 verify 명령을 직접 실행해 확정한다 (§6.2.1)
    if step == 'test' and parseTests == PASS and project has verify:
        if verify exit != 0: cursor = index('planner'); pendingFeedback = verify tail; continue

    # runtime 설정이 있으면 up → healthcheck → checks → verifier → down 순서 (§6.2.2)
    if step == 'test' and parseTests == PASS and project has runtime:
        runRuntimeVerification()
        if failed: cursor = index('planner'); pendingFeedback = evidence; continue

    # review: NEEDS-WORK + [ROUTE: ...] 이면 되돌린다. SHIP → cicd 진행, BLOCKED → 종료
    if step == 'review':
        if verdict == SHIP: cursor += 1; continue
        if verdict == NEEDS-WORK and [ROUTE: planner|clarifier]:
            cursor = index(route); pendingFeedback = result; continue
        break

    cursor += 1

if cursor == len(STEP_ORDER) and core workflow succeeded:
    run checking-docs-before-commit skill
    if docs ready: run atomic-commit skill
```

- **clarifier 게이트**: clarifier JSON 이 `ready: false` 이면 planner/scaffold 로
  넘어가지 않고 질문과 추천 답안을 반환한다. `ready: true` 이고 `summary` 가 있으면
  planner 는 원본 대신 그 정리본을 입력으로 받는다. 대시보드의 자동 구체화는 추천 답안을
  다음 clarifier 입력에 누적하며, 최대 라운드는 사용자가 지정한다 (`0` 또는 미지정은 무제한).
- **질문 답변 재개** (`workflows/spec-session.ts`): 대시보드에서 멈춘 run 에 답변을
  입력하면 `resumeSpecSession` 이 `clarification_state`(원본 스펙 + 라운드별 Q&A)를
  읽어 "스펙 + 누적 Q&A" 를 clarifier 에 재투입하는 **연결된 새 run** 을 시작한다
  (원본 run 은 보존, 스펙 재입력 불필요). 게이트가 반복되면 라운드가 누적된다.
  `autoClarify`와 `maxClarifyRounds`도 상태에 저장해 중단 후 답변 재개 시 유지하며,
  답변 폼에서 두 값을 덮어쓸 수 있다.
  각 실행 row는 최초 spec run ID인 `spec_session_id`를 공유한다. 최근 실행 목록과
  `/api/runs/:id/children`은 이 값을 기준으로 최초 clarifier 실행부터 답변 후속 실행까지
  하나의 spec 요청 이력으로 묶는다.
  planner 는 `Read`-only 를 유지하고, **세션 코드**가 `<cwd>/docs/plan/<slug>.md` 에
  원본 스펙 + 의사결정 히스토리 + planner 산출 플랜을 매 실행마다 전체 스냅샷으로 기록한다
  (`workflows/clarification.ts` 가 slug·Q&A 합성·문서 렌더링 순수 함수를 제공).
- **입력 분기** (`inputFor`): clarifier 는 원본 스펙을, planner 는 clarifier summary
  또는 원본 스펙을, 그 외 단계는 planner 산출물(plan)을 입력으로 받는다. 라우팅된 경우
  직전 단계 출력 전문이 피드백 블록으로 덧붙는다. cicd 는 planner 가 할당한 cicd 항목만
  전달받으며, 할당이 없으면 해당 단계를 건너뛴다.
- **단계 출력 계약**: Codex 실행에서도 `clarifier`/`planner`/`test`/`review`는 generic
  JSON 변환 없이 raw 출력을 보존한다. planner의 `PLAN: ... END.` 구조와 test의
  `[TESTS: ...]` 마커가 없으면 `invalid_output`으로 즉시 BLOCKED 처리하며, 유효한 이전
  `planOutput`을 오류 문자열로 덮어쓰지 않는다.
  generic 에이전트가 완전한 `status: success` 최종 계약을 보낸 뒤 CLI 정리 중 timeout
  종료코드 `124`가 발생한 경우는 완료로 보존해 false failure를 막는다.
- **review 작업 경계**: review는 지정된 `cwd`만 검사한다. 대상에 `.git`이 없어도 부모나
  형제 디렉터리에서 다른 저장소를 찾지 않고 현재 프로젝트 파일을 직접 읽는다.
- **성공 후 커밋** (`workflows/post-success-commit.ts`): core 단계가 끝까지 성공한 경우에만
  `checking-docs-before-commit → atomic-commit`을 백그라운드에서 실행한다. 두 run은 spec
  children에 포함하지 않으며 review 통과로 확정된 spec 상태를 바꾸지 않는다. `lib/skill-loader.ts`가
  `AUTO_DEV_SKILLS_ROOT`, `~/.codex/skills`, `~/.claude/skills` 순으로 실제 전역
  `SKILL.md`를 읽어 provider와 무관하게 프롬프트에 주입한다. docs 단계는 `[DOCS: READY]`,
  commit 단계는 `[COMMIT: DONE]` 또는 `[COMMIT: NO-CHANGES]` 계약을 충족해야 한다.
  clarifier 대기·실패·취소·안전 상한 종료에는 실행하지 않으며, 후처리 실패는 별도 로그로 남긴다.
  commit 단계는 원본 spec·확정 범위·planner 출력과
  docs 결과를 받아 관련 파일/hunk만 stage하고, 기존 사용자 변경·push·history rewrite를 금지한다.
- **피드백 출처**(`FeedbackSource`)는 `Step` 보다 넓다. 에이전트 단계 외에 오케스트레이터가
  직접 관찰한 `verify`, `role-boundary` 도 재작업 근거가 된다.
- **라우팅 대상**은 review/test 가 출력 끝의 `[ROUTE: planner]` / `[ROUTE: clarifier]`
  마커로 직접 지정한다. clarifier = 요구사항 모호, planner = 구현/설계 결함.
  `NEEDS-WORK`/`TESTS: FAIL`인데 provider가 ROUTE 마커를 누락하면 구현 결함의 기본
  소유자인 planner로 폴백한다. 마커 누락만으로 workflow를 종료하지 않는다.
- **재작업 루프 방지**: `maxRoutes`(= `--iterations`, 기본 4, 최대 10) 만큼만 review/test 라우팅을
  되돌리고, `safetyCap` 으로 라우팅 기반 총 실행 횟수도 제한한다. 자동 구체화가 무제한이면
  clarifier 반복은 이 cap에서 제외되므로 모델이 계속 질문할 경우 비용과 시간이 계속 증가한다.
- `--steps` 로 특정 단계만 실행 가능. 라우팅 대상이 필터에서 빠져 있으면 라우팅하지 않는다.
- 모든 자식 실행은 동일한 `workflowRunId` 로 묶여 DB 에서 추적 가능 (재작업 포함).

### 6.2.1 결정적 검증 게이트 (verify)

통과 판정의 근거를 LLM 의 자기 보고에서 **오케스트레이터가 직접 관찰한 종료 코드**로
옮기는 장치다. 대상 프로젝트가 `<projectDir>/.auto-dev/project.json` 에 `verify` 를
선언했을 때만 이 게이트가 동작한다. 런타임 설정은 §6.2.2 에서 별도로 다룬다.

```json
{
  "version": 1,
  "verify": { "command": "./gradlew check", "timeoutMs": 900000 },
  "roleBoundary": {
    "testGlobs": ["src/test/**", "**/*.test.ts"],
    "ignoreGlobs": []
  }
}
```

- 로더는 `src/lib/project-config.ts`. 파일이 없으면 `undefined`, **스키마가 틀리면
  설정 경로와 원인을 담은 `ProjectConfigError` 로 run 을 실패시킨다** (조용한 무시 금지).
  모르는 최상위 필드는 무시해 후속 Phase 의 필드 추가와 전방 호환된다.
- 실행기는 `src/lib/verify.ts`. `bash -c` + `detached: true` 로 띄워 자식이 프로세스
  그룹 리더가 되게 하고, 타임아웃·취소 시 그룹 전체(`SIGTERM` → 유예 후 `SIGKILL`)를
  정리한다. 출력은 stdout+stderr 합쳐 마지막 200줄 / 20KB 만 보관한다.
- 게이트 단계는 `src/workflows/verify-gate.ts` 의 `runVerifyStep`. `agent_run` 에
  `agent_name='verify'` 행으로 기록하므로 대시보드 워크플로 상세가 기존 자식 단계 렌더링
  그대로 종료 코드 요약·소요 시간·출력 꼬리를 보여준다. **스키마 변경은 없다.**
  run id 로 `registerRunCancellation` 에 등록하므로 대시보드의 run 취소로도 중단된다.

**판정 표**

| `[TESTS: …]` | verify 결과 | 처리 |
|---|---|---|
| `PASS` | exit 0 | review 로 진행 |
| `PASS` | exit ≠ 0 / timeout / 취소 | 마커를 무시하고 출력 꼬리를 피드백으로 붙여 planner 로 라우팅 |
| `PASS` | 설정 없음 | 기존 동작 유지 + `verify_not_configured` 경고 이벤트 |
| `FAIL` | 실행하지 않음 | 기존 동작 유지 (라우팅) |
| `BLOCKED` | 실행하지 않음 | 기존 동작 유지 (종료) |

라우트 예산이 소진되면 `failure.cause = 'verify_failed'`, `failure.step = 'verify'` 로
종료한다. 동적 팀(TEAM_PLAN) 경로도 통합이 끝난 뒤 같은 게이트를 통과해야 하며, DAG 안의
review 태스크는 `verify` 또는 `runtime` 게이트가 설정된 경우 게이트 뒤에 실행한다.

**역할 경계 사후 검사** (`src/lib/role-boundary.ts`)

test 에이전트도 `Bash` 를 가지므로 프로덕션 소스를 바꾸는 것이 물리적으로 가능하다.
프롬프트 금지만으로는 막히지 않으므로 사후 검사한다.

1. test 단계 직전에 변경·미추적 파일의 **내용 해시 스냅샷**을 만든다
   (`git status --porcelain -z -uall` + 파일별 SHA-1). 이미 scaffold 가 소스를 바꿔 둔
   상태이므로 파일 이름 목록 비교로는 부족하다.
2. test 단계 직후 다시 스냅샷을 만들어 비교한다.
3. 내용이 바뀐 경로 중 `testGlobs` 에도 `ignoreGlobs` 에도 없는 것이 있으면
   `cause: 'role_boundary_violation'` 으로 실패시킨다.

- 위반 파일을 되돌리지 않고 보고만 한다 — 워크스페이스를 임의로 수정하면 사람이 원인을
  추적할 근거가 사라진다.
- `.git` 이 없으면 검사를 건너뛰고 `role_boundary_skipped` 경고 이벤트를 남긴다.
- gitignore 된 빌드 산출물은 `git status` 가 보고하지 않으므로 자동 제외된다. 그 외
  오탐은 `ignoreGlobs` 로 처리한다.
- `testGlobs` 가 비어 있으면 판정 기준이 없으므로 검사를 수행하지 않는다.

**프롬프트 주입**: `verify` 가 선언되어 있으면 scaffold·test 입력에 `## 검증 명령` 절이
붙는다. test 프롬프트는 "PASS 를 선언하기 전에 같은 명령을 직접 실행하라" 를 명시한다.

### 6.2.2 실제 런타임 검증

`runtime` 설정은 HTTP 응답과 독립 verifier의 관찰까지 포함해 통과 여부를 정한다.

```json
{
  "version": 1,
  "runtime": {
    "up": "docker compose up -d --wait",
    "down": "docker compose down -v",
    "healthcheck": { "url": "http://localhost:8080/actuator/health", "timeoutMs": 120000 },
    "checks": [".auto-dev/checks/smoke.sh"]
  }
}
```

- `src/lib/project-config.ts`가 `runtime.up/down`, HTTP(S) healthcheck URL과 제한 시간,
  프로젝트 밖으로 벗어나지 않는 상대 `checks` 경로를 검증한다. healthcheck 제한 시간은
  기본 120초다. 셸 명령은 기본 15분 제한으로 실행한다.
- `src/workflows/runtime-gate.ts`가 `[TESTS: PASS]`와 Phase 1 `verify` 종료 코드 0 뒤에
  런타임을 시작하고 healthcheck를 재시도한 다음 각 check 스크립트를 실행한다. 결정적
  단계 중 하나라도 실패하면 verifier를 호출하지 않고 증거를 planner에 전달한다.
- 이후 새 `verifier` run은 `Read`, `Bash`만 사용해 스펙과 feature-map을 바탕으로 서비스에
  실제 요청·조회한다. `[VERIFY: PASS]`만 통과 신호다. `FAIL`, 마커 누락, 실행 실패는
  planner로 피드백한다. `[VERIFY: BLOCKED]`는 workflow를 BLOCKED로 끝낸다.
- verifier 직전·직후 `snapshotWorkspace()`를 비교한다. 변경 파일이 있으면
  `role_boundary_violation`으로 실패시키고 파일은 되돌리지 않는다. git 저장소가 아니면
  검사를 건너뛰고 경고 이벤트를 남긴다.
- `down`은 성공·실패·취소와 관계없이 `finally`에서 실행한다. cleanup은 취소 신호와
  분리해 취소 중에도 프로세스를 띄우며, 종료 코드가 0이 아니면 검증 실패로 처리한다.
- 각 실행은 `COMPOSE_PROJECT_NAME=autodev-<workflowRunId 앞 8자리>`를 runtime 명령과
  verifier 도구에 전달한다. Compose project name은 서비스·네트워크·볼륨 이름을 분리하지만
  published 호스트 포트는 분리하지 않는다. 병렬 실행 시 `ports: ["${WEB_PORT:-8080}:8080"]`
  처럼 포트를 변수화하고 각 run에 고유한 사용 가능 포트를 설정해야 한다.
- `src/lib/evidence.ts`가 request/response, check·up/down 출력 꼬리, verifier report를
  `data/evidence/<workflowRunId>/evidence.json`에 저장한다. review 입력에도 증거 요약을
  전달한다. `GET /api/runs/:id/evidence`와 workflow 상세의 접이식 증거 섹션으로 열람한다.
  SQLite 스키마 변경은 없다.
- `AGENT_ORDER`와 planner의 `PLAN:` 계약은 바꾸지 않는다. verifier는
  `AGENT_SPECS`에 내부 agent로 등록하고 일반 단계 선택 목록에는 노출하지 않는다.

### 6.2.3 버그 이슈 재현 우선 흐름

- `src/workflows/from-issue.ts`는 타입이 정확히 `BUG`인 이슈(대소문자·앞뒤 공백 무시)에
  한해 일반 SpecWorkflow 전에 test 에이전트를 호출한다. 이슈 트래커 문서가 열거한 타입은
  `TASK | BUG | IDEA | FOLLOWUP`이며, 런타임 타입 값은 별도 enum으로 강제하지 않는다.
- 첫 test 실행은 테스트 파일만 작성하도록 지시하고 `[REPRO: <command>]`를 파싱한다.
  실행 전후 workspace 해시를 비교해 설정된 `testGlobs` 또는 기본 테스트 경로 밖 변경을
  `role_boundary_violation`으로 막는다. git이 없으면 기존 역할 경계 검사와 같이 경고 후 생략한다.
- Phase 1 verify 실행기를 재사용해 명령을 프로젝트 디렉터리에서 실행한다. 수정 전 종료 코드가
  0이면 `BLOCKED`, `not_reproduced`로 보고하고 이슈 상태를 바꾸지 않는다. 비정상 종료를
  관찰한 경우에만 이슈를 `IN_PROGRESS`로 바꿔 planner부터 시작한다.
- 버그 모드는 재현 명령을 매 test 단계 직후 다시 실행한다. 종료 코드 0이 아니면 재작업
  피드백으로 planner에 되돌리고, route 예산이 끝나면 `reproduction_failed`로 실패한다.
  통과해야 Phase 1 verify, Phase 3 runtime gate, review로 넘어간다. 내부 REPRO 마커의
  파서·test 프롬프트·테스트는 같은 변경 단위로 관리한다.
- 버그 이슈에는 `agent_name='spec'` 부모 run을 만들어 사전 재현 테스트와 명령 결과를
  대시보드 상세의 자식 실행으로 연결한다. 일반 이슈 경로는 기존 흐름을 유지한다.

### 6.2.4 review findings와 학습 후보

- `prompts/review.system.md`는 기존 verdict/route 계약 앞에 `FINDINGS_JSON` 블록을
  요구한다. `src/lib/review-findings.ts`가 severity/category/rule_hint/file을 검증하며,
  파싱 또는 저장 실패는 review run의 `warn` 이벤트로만 남긴다.
- Findings와 오케스트레이터가 관찰한 `verify`, `role-boundary` 실패는
  `review_finding` 테이블에 저장한다. `src/store/schema.sql`의 `CREATE TABLE IF NOT EXISTS`가
  기존 DB에도 테이블을 추가하므로 별도 ALTER 마이그레이션은 필요 없다.
- `getReviewFindingCandidates()`는 최근 14일을 `project + category + rule_hint`로 집계하고
  프로젝트별 빈도 상위 5개를 반환한다. `/api/review-findings/candidates`가 대시보드에
  제공하고 `briefing.ts`가 일일 브리핑에 포함한다.
- 승격은 자동 적용하지 않는다. 사람이 후보를 검토해 대상 저장소의 `AGENTS.md` 또는
  ArchUnit/Checkstyle/CI 검사 같은 하드 규칙으로 옮긴다.

### 6.2.5 auto-dev 자체 평가

- `./run eval [--case <id>] [--models id1,id2]`는 `src/workflows/eval.ts`가
  `evals/cases/<id>/`의 `spec.md`, fixture, `checks.sh`, `meta.json`을 읽어 실행한다.
  fixture는 OS 임시 디렉터리에 복사되고 평가가 끝나면 삭제된다.
- 각 case/model 실행은 `agent_run`의 `agent_name='eval'`, `trigger_source='eval'` 행으로
  기록되며, 하위 agent는 같은 workflow ID에 묶인다. `costGuard.allow()`가 거부하면
  `BLOCKED`로 기록하고 해당 실행을 건너뛴다.
- `--models`는 요청한 runnable model ID를 AGENT_ORDER의 각 역할과 내부 verifier에
  실행 단위로 적용한다. `AsyncLocalStorage`로 비동기 호출 트리 안에서만 해석하므로
  동시 평가 사이에 섞이거나 전역 `agentModels` 설정을 변경하지 않는다. 옵션이 없으면
  현재 역할별 모델 구성을 고정해 실행하고 결과에 기록한다.
- `meta.json`의 `expectedResult`는 `SHIP` 또는 `CLARIFICATION`이다. 선택적인
  `reproCommand`가 있으면 fixture 초기 상태에서 먼저 실패하는지 확인한 뒤, `runSpec`이
  동일 명령의 수정 후 통과를 요구한다. `timeoutMs`는 case 전체 제한 시간이며 `runSpec`과
  셸 명령에 전달된다. `checks.sh`에는 verdict와 route count가 환경변수로 전달되며,
  예상 verdict와 스크립트 종료 코드가 모두 맞아야 통과다.
- 결과 JSON은 `data/evals/<timestamp>.json`에 원자적으로 저장한다. 직전 결과와 같은
  case/model 키를 비교해 통과 상태가 바뀐 회귀·개선을 요약하며 route count, 토큰,
  duration, 검증 출력도 보관한다. eval은 성공 후 문서 점검/자동 커밋을 실행하지 않는다.
- 기본 케이스는 작은 TypeScript 회귀, Spring Boot/PostgreSQL 이메일 버그 재현, 모호한
  결제 스펙 clarification이다. 외부 Maven 의존성을 받는 Spring 케이스를 포함해 모든
  명령은 fixture에서 실행된다. 자동 CI 기준선/PR 차단은 이 Phase 범위가 아니다.

### 6.2.6 재시작 체크포인트

- 대시보드 spec은 대상 프로젝트가 `.auto-dev/project.json`에
  `workflow.resumeOnRestart: true`를 명시한 경우에만 `workflow_checkpoint`를 만든다.
  설정이 없거나 false이면 기존 startup `server_restart` 처리와 실행 경로를 유지한다.
- opt-in run은 시작 시 깨끗한 Git 작업 트리를 요구한다. 각 에이전트 호출 전에
  cursor/라우팅 상태, 입력, 파일 해시, Git HEAD를 저장하고 lease heartbeat를 갱신한다.
  완료 child 결과는 재사용한다. 중단된 에이전트는 `AGENT_SPECS`의 도구가 `Read`만
  허용할 때 파일 해시와 HEAD가 그대로인 경우에 한해 같은 입력으로 재실행한다. `Write`나
  `Bash` 권한이 있으면 gitignore 파일 변경을 배제할 수 없어 자동 재실행하지 않는다.
- 동적 팀, verify, runtime, 성공 후 전달 작업은 현재 복구 시 재생하지 않는다. 이 작업 중
  lease가 만료되면 `RECOVERY_REQUIRED`로 부모 run을 실패 처리하고 작업 파일을 보존한다.
  대시보드 상세 화면과 `GET /api/runs/:id/checkpoint`가 상태 및 사유를 제공한다.
- 현재 구현은 원본 checkout에서 실행하므로 시작 시점의 깨끗한 작업 트리 이후에도
  에이전트가 만든 변경은 유지된다. run 전용 worktree와 원본 checkout 통합은 지원하지 않는다.

### 6.3 Java 버전 대비 미구현 항목

| 기능 | Java | TypeScript |
|---|---|---|
| Planner 모드 | `Plan.parse()` → 동적 step 목록 | 부분 구현 (미할당 cicd 생략 + 고정 순서 라우팅 재진입) |
| Test-pass loop | attempt 1..3, `[TESTS: FAIL]` 재시도 | ✅ 피드백 라우팅으로 구현 (§6.2) |
| summary.md 출력 | 토큰·비용·소요시간 표 | 미구현 |
| 출력 디렉토리 | `docs/output/<spec>-<ts>/` | 미구현 |

---

## 7. 영속화

### 7.1 SQLite — `agent_run` 테이블

```sql
CREATE TABLE agent_run (
  id            TEXT PRIMARY KEY,      -- UUID
  agent_name    TEXT NOT NULL,         -- scaffold / review / test / cicd / planner / clarifier
                                       -- + 내부 단계: verify(§6.2.1) / integrator /
                                       --   checking-docs-before-commit / atomic-commit
  input         TEXT,                  -- 에이전트가 받은 프롬프트
  output        TEXT,                  -- 에이전트 응답
  tokens_in     INTEGER DEFAULT 0,
  tokens_out    INTEGER DEFAULT 0,
  status        TEXT NOT NULL,         -- RUNNING / DONE / FAILED / BLOCKED
  started_at    TEXT NOT NULL,         -- ISO 8601
  duration_ms   INTEGER DEFAULT 0,
  trigger_source TEXT,                 -- cli / api / schedule / workflow
  trigger_detail TEXT,
  workflow_run_id TEXT,                -- 워크플로우 내 자식 호출 그룹화
  spec_session_id TEXT,                -- clarifier 답변/후속 실행을 최초 spec 요청으로 그룹화
  -- 이하 마이그레이션으로 추가 (db.ts):
  error_type TEXT, stop_reason TEXT, num_turns INTEGER DEFAULT 0,
  clarification_state TEXT             -- spec 재개용 상태 JSON (원본 스펙 + 라운드별 Q&A)
);

CREATE TABLE workflow_checkpoint (
  workflow_run_id TEXT PRIMARY KEY REFERENCES agent_run(id),
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  updated_at TEXT NOT NULL
);
```

체크포인트는 opt-in한 dashboard spec의 직렬화 상태와 fencing revision, lease를 저장한다.
부모 `agent_run`과 체크포인트의 종료 상태는 한 SQLite transaction으로 함께 기록한다.

Java 버전 대비 제거된 컬럼:
- `cost_usd` — 구독 플랜이므로 per-call 비용 없음

`review_finding` 테이블은 §6.2.4의 review finding 및 검증 실패 기록에 사용한다.
Java 버전의 multi-lens JSON dedup 파싱은 별도로 구현하지 않는다.

### 7.2 파일 산출물

```
data/
├── auto-dev.db          # SQLite (gitignore)
├── workspace/           # 에이전트 cwd (gitignore)
└── evidence/            # runtime 관찰 결과 (gitignore), workflow id별 evidence.json

<project>/docs/plan/<slug>.md   # spec 세션마다 누적 기록: 원본 스펙 + 의사결정 + 플랜
```

---

## 8. 트리거 진입점

### 8.1 CLI (Commander 서브커맨드)

```bash
./run scaffold "<input 또는 파일 경로>"
./run review "<input 또는 파일 경로>"
./run test "<input 또는 파일 경로>"
./run cicd "<input 또는 파일 경로>"
./run planner "<input 또는 파일 경로>"
./run clarifier "<input 또는 파일 경로>"

./run spec <file>                            # SpecWorkflow
            --steps scaffold,test,review     # 부분 실행
            --iterations 4                   # 재작업 라우팅 상한 (기본 4, 최대 10)

./run status                                  # 에이전트 목록 + 실행 가드 통계
./run serve                                   # HTTP API + 대시보드 + 스케줄러
./run daemon                                  # serve 와 동일 (alias)
```

입력 감지: `existsSync(input)` 가 true 이면 파일 읽기, 아니면 인라인 문자열.

### 8.2 HTTP API (`serve` 모드)

| Method | Path | 설명 |
|---|---|---|
| `GET` | `/api/status` | 에이전트 목록 + 실행 가드 + 회로차단기 통계 |
| `GET` | `/api/auth/claude` | Claude Code 로그인 상태 조회 (루프백 대시보드 전용) |
| `POST` | `/api/auth/claude/login` | SDK OAuth flow 시작 + allowlist 검증된 로그인 URL 반환 |
| `POST` | `/api/auth/claude/code` | 브라우저의 `code#state` 교환 완료 + 모델 목록 갱신 |
| `POST` | `/api/agents/:name` | 단일 에이전트 실행 `{ input, project? }` |
| `POST` | `/api/clarify` | clarifier 실행 `{ input }` |
| `POST` | `/api/specs` | SpecWorkflow 실행 `{ content, steps?, iterations? }` |
| `GET` | `/api/integrations/openclaw/health` | OpenClaw 루프백 bridge 상태 + 계정 |
| `POST` | `/api/integrations/openclaw/specs` | background spec 시작, `202 + runId` 즉시 반환 |
| `POST` | `/api/submit` | 대시보드 폼 제출 (multipart — 파일/프로젝트명 포함) |
| `POST` | `/api/llm/complete` | 단발성 LLM 생성 프록시 `{ system?, message, json? }` (CORS 허용) |
| `POST` | `/api/chat` | **NDJSON** 스트리밍 채팅. 일반/프로젝트 모드, 최근 대화, 관련 장기 기억, 모델 선택 입력 |
| `POST` | `/api/chat/memory` | 오래된 대화를 주제별 Markdown 기억으로 압축해 반환. 서버 영속화 없음 |
| `GET` | `/api/runs?units=N` | 최근 실행 유닛 N개 (parent + children 묶음, `{ rows, hasMore }` 반환) |
| `GET` | `/api/runs/:id` | 단일 실행 상세 |
| `GET` | `/api/runs/:id/checkpoint` | opt-in workflow 재시작 복구 상태 |
| `GET` | `/api/runs/:id/evidence` | 런타임 검증 요청·응답·출력·verifier 증거 |
| `POST` | `/api/runs/:id/cancel` | 실행 중인 workflow/agent 취소. 부모 취소는 현재 child provider까지 전파 |
| `GET` | `/api/runs/:id/children` | 워크플로우 하위 실행 목록 |
| `GET` | `/api/runs/:id/clarification` | 멈춘 spec run 의 대기 중 clarifier 질문 (추천 답안 포함) |
| `POST` | `/api/runs/:id/answers` | `{ answers }` 로 spec 워크플로우 재개 — 스펙 재입력 없이 연결된 새 run 생성 |
| `POST` | `/api/runs/:id/continue` | 완료된 spec run 을 후속 지시와 함께 재실행 |
| `POST` | `/api/runs/:id/resume-last` | 마지막 실행 단계부터 재개 |
| `GET` | `/api/runs/:id/events` | **SSE** — 실행 중 라이브 이벤트 (text/tool/status) |
| `GET` | `/api/runs/:id/events/history` | 저장된 실행 이벤트 이력 |
| `GET` | `/api/stats` | 집계 통계 (total, today, byStatus, byAgent) |
| `GET`/`POST` | `/api/config` | 모델/effort/fallback/에이전트별 모델 조회·변경 + 워크스페이스/프로젝트 목록. POST 변경은 런타임 설정 JSON에 저장 |
| `GET` | `/api/issues` | issue-tracker 열린 이슈 조회 |
| `POST` | `/api/issues/:key/run` | 이슈 1건 자동 처리 워크플로우 트리거 |
| 외부 연동 | `POST /automation/jobs` 등 | issue-tracker automation job 생성·claim·heartbeat·review |

### 8.3 스케줄러 (node-cron)

```typescript
// src/schedule/briefing.ts
cron.schedule('0 9 * * *', async () => {
  await review('워크로그 브리핑...', { triggerSource: 'schedule' });
});
```

- `AUTO_DEV_WORKLOG_BRIEFING_ENABLED=true` 설정 시 활성 (기본 비활성)
- 크론 표현식: `AUTO_DEV_WORKLOG_BRIEFING_CRON` (기본 `0 9 * * *`)

---

## 9. 관찰성 (Dashboard)

실행 중인 row와 상세 요약은 시작 시각을 기준으로 소요시간을 매초 계산한다. 재개된 spec
시도는 새 run 행으로 시작해 `duration_ms`에 이번 시도분만 담기므로, 서버가 같은 세션의
이전 시도 합계를 `session_prior_duration_ms`로 함께 내려 목록·상세가 세션 전체
소요시간(이전 누적 + 이번 시도)을 보여준다. provider의
usage 이벤트는 `tokens_in`/`tokens_out`에 즉시 저장하고 SSE로 전달하며, 상세 화면은
input/output을 분리해 갱신한다. spec 이력은 `spec_session_id` 단위로 접어서 표시하고,
목록·상세에는 stable spec ID를 노출한다. 재개된 최상위 spec 상세는 별도 run ID도,
하위 에이전트 상세는 실제 workflow ID도 함께 표시한다.

실행 중인 이력 행·제출 결과·상세 패널에서 강제 중단할 수 있다. 서버는 run별
`AbortController`를 등록하고 Anthropic query 또는 Codex subprocess에 신호를 전달한다.
기존 SQLite status CHECK와의 호환을 위해 DB에는 `FAILED` + `error_type=user_cancelled`로
저장하고, 대시보드는 이를 `CANCELLED`로 표시한다.

### 9.1 페이지 구성 (`http://127.0.0.1:8080/`)

```
┌─ auto-dev ─────────────────────────────────────────────┐
│  [오늘 실행]  [전체 실행]  [에이전트 badge 목록]        │
│                                                         │
│  [최근 실행 (30개)] [새로고침]                          │
│   에이전트 | 상태 | 소요시간 | 출력 미리보기 | 시작시간 │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

- 정적 HTML (`static/index.html`) — `@hono/node-server/serve-static` 서빙
- 10초마다 `/api/status`, `/api/stats`, `/api/runs` 자동 폴링 (목록·통계)
- 실행 중(RUNNING) 행은 `/api/runs/:id/events` **SSE** 로 라이브 갱신
- run 행 클릭 → 상세 패널 펼치기 (메타 + 출력, 실행 중이면 라이브 이벤트 스트림)
- 작업 제출 폼: 에이전트 선택 + 프로젝트명 입력(자동완성) + 모델/effort 설정
- 우하단 플로팅 채팅: 일반/프로젝트 모드, 독립 프로젝트·모델 선택, Markdown 스트리밍,
  생성 중지·재시도, 새 대화·기억 삭제·전체 삭제
- 채팅 원본 대화와 장기 기억은 프로젝트별 브라우저 `localStorage`에만 보관한다.
  최근 30,000자를 요청에 싣고, 오래된 지속 정보는 `## 주제` Markdown 섹션으로 압축한다.
- 프로젝트 문맥은 `chat-context.ts`가 README + 필터된 파일 목록 + 관련 텍스트 최대
  8개/100KB로 제한한다. 낮은 키워드 점수는 모델 기반 경로 분류로 보완한다. 민감 파일,
  바이너리, `.git`/`node_modules`/`dist`/`build`, 프로젝트 밖 symlink 대상은 읽지 않는다.
- Claude 로그아웃 때 OAuth 모달 표시. `code#state` 교환 성공 뒤 같은 모달을
  `authenticated` 성공 상태로 유지하고 사용자가 확인하면 닫는다.

### 9.2 Java 버전 대비 미구현

- 이슈 카드 그리드 (API `/api/issues` 는 있으나 대시보드 UI 미연동)
- Plan / Plan & Run 버튼 (동적 planner 모드 미구현)
- Per-agent summary 테이블
- 통화 토글 (USD ↔ KRW) — 구독 모델이라 per-token 비용 개념 없음(의도적 N/A)

---

## 10. 리질리언스

### 10.1 일일 실행 가드 (`costGuard`)

- `AUTO_DEV_DAILY_RUN_LIMIT` 초과 시 BLOCKED 즉시 반환 (기본 100회)
- 변수를 비우면 `limit = null` → **무제한** (가드 비활성)
- 자정 (`Asia/Seoul`) 자동 리셋
- DB 재시작 시 카운터 0 (비휘발성 복원 미구현)

### 10.2 rate-limit 회로차단기 (`circuitBreaker`)

프로바이더가 rate limit(`AgentEvent: rate_limit`)을 알리면 회로를 열어 후속 실행을
즉시 BLOCKED 처리한다. 런어웨이 자동화가 429 폭주를 일으키는 것을 막는다.

| 신호 | 동작 |
|---|---|
| `resetsAt` 제공 | 해당 시각까지 회로 open |
| `retryDelayMs` 제공 | 현재시각 + delay 까지 open |
| 둘 다 없음 | `AUTO_DEV_CIRCUIT_BREAKER_FALLBACK_MS`(기본 5분) 쿨다운 |

`_initRun` 이 실행 전 `circuitBreaker.isOpen()` 을 검사하고, open 이면 BLOCKED row 를
남기고 반환한다. 상태는 메모리(재시작 시 닫힘).

rate limit 또는 `anthropic_auth_failed`/`codex_auth_failed`가 발생하고 서로 다른
`AUTO_DEV_FALLBACK_MODEL`이 설정돼 있으면 현재 실행 안에서 fallback을 한 번 시도한다.
auth fallback은 회로를 열지 않으며, fallback도 실패하면 최종 오류를 그대로 기록한다.

### 10.3 SDK 내장 안전망

Java 버전에서 직접 구현했던 아래 항목들을 SDK 가 처리:

| 기능 | Java (자체 구현) | TypeScript (SDK 위임) |
|---|---|---|
| 429 재시도 | `executeWithRetry` — 메시지 파싱 + sleep | SDK 내부 + 회로차단기(§10.2) |
| 토큰 budget | `PromptBudget.clamp` — head+marker+tail | SDK 컨텍스트 관리 |
| 세션 관리 | N/A (stateless) | SDK 자동 |

### 10.4 Verdict / 라우팅 마커 기반 제어 흐름

오케스트레이터(`runSpec`)는 review/test 출력 끝의 마커를 파싱해 흐름을 제어한다:

| 마커 | 발생 | 효과 |
|---|---|---|
| `[VERDICT: SHIP]` | review | 통과 → cicd 진행 |
| `[VERDICT: NEEDS-WORK]` + `[ROUTE: planner\|clarifier]` | review | 지정 단계로 되돌려 재작업 |
| `[VERDICT: NEEDS-WORK]` (라우트 없음) | review | `planner`로 폴백 |
| `[VERDICT: NEEDS-WORK]` (대상 비활성/예산 소진) | review | 원인을 `failure cause`에 기록하고 cicd 미진행, 종료 |
| `[VERDICT: BLOCKED]` | review | 종료 (사람 개입 필요) |
| `[TESTS: FAIL]` + `[ROUTE: planner\|clarifier]` | test | 소스 오류 → 지정 단계로 되돌려 재작업 |
| `[TESTS: PASS]` | test | verify 설정이 있으면 종료 코드로 확정, 없으면 다음 단계 진행 (§6.2.1) |
| `[TESTS: FAIL]` (라우트 없음) | test | `planner`로 폴백 |
| `[TESTS: FAIL]` (대상 비활성/예산 소진) | test | 원인을 기록하고 즉시 실패 종료 |
| `[TESTS: BLOCKED]` | test | 차단 원인을 기록하고 즉시 실패 종료 |

- review의 `FINDINGS_JSON` 블록은 제어 마커가 아니다. verdict/route 앞에서 파싱해
  `review_finding`에 저장하며, 블록 오류는 경고 이벤트만 남긴다 (§6.2.4).
- 라우팅은 `maxRoutes`(`--iterations`, 기본 4, 최대 10) 와 `safetyCap` 으로 이중 제한해 무한
  루프를 막는다.
- 테스트 코드 오류는 test 에이전트가 자기 실행 안에서 직접 수정하므로 라우팅 대상이
  아니다. 라우팅되는 것은 **소스 코드 오류로 판정된 FAIL** 뿐이다.
- 마커는 보조 신호다. 결정적 신호(verify 종료 코드)가 있으면 그쪽이 이긴다. 오케스트레이터가
  소유한 판정은 `failure.cause` 의 `verify_failed` / `role_boundary_violation` 으로 구분된다
  (§6.2.1).

### 10.5 dashboard spec 재시작 복구

- 대상 프로젝트의 `workflow.resumeOnRestart: true`가 명시된 dashboard spec만
  `workflow_checkpoint`에 직렬화 상태와 host/PID lease를 저장한다. 체크포인트 revision이
  fencing token으로 동작해 이전 worker의 갱신을 거부한다.
- 서버 startup은 만료 lease만 원자적으로 claim한다. 같은 host의 이전 프로세스가 살아 있으면
  경합을 피하려고 claim을 미루고, 다른 host 소유나 설정 fingerprint 불일치는 복구를 멈춘다.
- 완료된 child는 DB 결과를 다시 소비해 중복 호출을 피한다. 미완료 agent는 호출 전 HEAD와
  변경 파일 해시가 그대로일 때 재시도한다. 팀, verify, runtime, 전달 중단은
  `RECOVERY_REQUIRED`로 표시하며 파일을 되돌리지 않는다 (§6.2.6).

---

## 11. 보안

### 11.1 Claude Code 인증

- `claude` CLI 가 사전 인증된 상태여야 동작
- 별도 API 키 불필요 — Claude.ai 구독 플랜 사용
- 인증 정보는 Claude Code 자체 관리 (`~/.claude/`)
- 루프백 대시보드에서만 SDK OAuth 로그인 flow를 시작할 수 있다. 서버는
  Claude/Anthropic HTTPS host allowlist와 OAuth state를 검증한다.
- 브라우저에는 로그인 URL과 공개 상태만 반환한다. OAuth code는 교환 직후 폐기하며
  토큰·자격증명을 브라우저 저장소나 SQLite에 기록하지 않는다.

### 11.2 워크스페이스 격리

- 모든 에이전트의 `cwd` 를 `AUTO_DEV_WORKSPACE_ROOT` 로 고정
- SDK `permissionMode: 'bypassPermissions'` — 확인 없이 자동 실행
- Java 버전의 `runShell` 위험 패턴 거부 (sudo / rm -rf / curl 등) 미구현
  → 에이전트가 위험한 명령을 실행할 수 있음. **신뢰된 환경에서만 사용 권장**

### 11.3 HTTP API

- 인증 없음. 기본 바인딩 `127.0.0.1` 으로만 보호
- `AUTO_DEV_BIND_ADDR=0.0.0.0` 외부 노출 시 별도 인증 추가 필요
- OpenClaw integration route는 서버 bind와 요청 host가 모두 loopback이어야 하며,
  선택적으로 `AUTO_DEV_OPENCLAW_API_TOKEN` Bearer 검증을 적용한다.

---

## 12. 설정

### 12.1 환경변수

| 키 | 기본값 | 설명 |
|---|---|---|
| `AUTO_DEV_PROVIDER` | `anthropic` | LLM 프로바이더 선택 (`src/llm/registry.ts`). 미등록 값이면 fail-fast |
| `AUTO_DEV_MODEL` | (CLI 기본) | 사용할 Claude 모델 id/별칭. 미지정 시 CLI 디스커버리 결과의 default |
| `AUTO_DEV_AGENT_<AGENT>_MODEL` | 미설정 | 에이전트별 모델 override. 예: `AUTO_DEV_AGENT_SCAFFOLD_MODEL` |
| `AUTO_DEV_FALLBACK_MODEL` | 미설정 | 선택 모델의 rate limit/auth 실패 시 한 번 재시도할 폴백 모델 |
| `AUTO_DEV_EFFORT` | `high` | effort 레벨 (`low`/`medium`/`high`/`xhigh`/`max`). 모델이 미지원이면 무시 |
| `AUTO_DEV_CONFIG_PATH` | `./data/config.json` | 대시보드에서 저장한 런타임 설정 파일. 저장값이 env보다 우선 |
| `AUTO_DEV_WORKSPACE_ROOT` | `./data/workspace` | 에이전트 cwd (프로젝트명 해석 기준 루트) |
| `AUTO_DEV_SKILLS_ROOT` | `~/.codex/skills`, 이후 `~/.claude/skills` | 성공한 spec commit 후처리의 전역 skill root override |
| `AUTO_DEV_DB_PATH` | `./data/auto-dev.db` | SQLite 경로 |
| `AUTO_DEV_BIND_ADDR` | `127.0.0.1` | HTTP 바인드 주소 |
| `AUTO_DEV_BIND_PORT` | `8080` | HTTP 포트 |
| `AUTO_DEV_DAILY_RUN_LIMIT` | `100` | 일일 에이전트 실행 횟수 한도 (비우면 무제한) |
| `AUTO_DEV_OPENCLAW_ENABLED` | `false` | OpenClaw Telegram 종료 상태 알림 활성 |
| `AUTO_DEV_OPENCLAW_ACCOUNT` | `main` | 알림 전송 Telegram 계정 |
| `AUTO_DEV_OPENCLAW_COMMAND` | `openclaw` | OpenClaw CLI 명령/절대 경로 |
| `AUTO_DEV_OPENCLAW_CONFIG_PATH` | `~/.openclaw/openclaw.json` | 계정 allowlist 조회 설정 |
| `AUTO_DEV_OPENCLAW_TARGET` | 계정 `allowFrom[0]` | Telegram chat ID override |
| `AUTO_DEV_OPENCLAW_API_TOKEN` | 미설정 | 루프백 bridge 선택적 Bearer 토큰 |
| `AUTO_DEV_CIRCUIT_BREAKER_FALLBACK_MS` | `300000` | rate-limit reset 미제공 시 회로 open 쿨다운(ms) |
| `AUTO_DEV_ISSUE_TRACKER_URL` | (없음) | issue-tracker 베이스 URL — 설정 시 연동 활성 |
| `AUTO_DEV_ISSUE_TRACKER_STATUS` | `OPEN` | 조회할 이슈 상태 필터 |
| `AUTO_DEV_WORKLOG_BRIEFING_ENABLED` | `false` | 일일 브리핑 스케줄러 활성 |
| `AUTO_DEV_WORKLOG_BRIEFING_CRON` | `0 9 * * *` | 브리핑 크론 표현식 |
| `AUTO_DEV_WORKLOG_PATH` | `./data/worklog.md` | 워크로그 파일 경로 |

### 12.2 대상 프로젝트 설정 파일

환경변수와 달리 **대상 프로젝트 저장소 안에** 두는 설정이다. auto-dev 가 그 프로젝트를
어떻게 검증하는지를 프로젝트 자신이 선언한다.

| 경로 | 필드 | 효과 |
|---|---|---|
| `<projectDir>/.auto-dev/project.json` | `version` | 필수. 현재 `1` 만 유효 |
| | `verify.command` | 결정적 검증 명령. 종료 코드 0 이 유일한 통과 신호 |
| | `verify.timeoutMs` | 기본 `900000` (15분) |
| | `runtime.up` / `runtime.down` | 런타임 기동·종료 셸 명령 |
| | `runtime.healthcheck.url` | 준비 완료를 확인할 HTTP(S) URL |
| | `runtime.healthcheck.timeoutMs` | 기본 `120000` (2분) |
| | `runtime.checks` | 프로젝트 안의 상대 check 스크립트 경로 목록 |
| | `roleBoundary.testGlobs` | test 단계가 수정해도 되는 경로. 비면 역할 경계 검사 생략 |
| | `roleBoundary.ignoreGlobs` | 오탐 제외 경로 |
| | `workflow.resumeOnRestart` | dashboard spec 재시작 복구 opt-in. 시작 시 깨끗한 Git 작업 트리 필요 |

파일이 없으면 모든 게이트가 비활성이고 workflow 는 기존과 동일하게 동작한다. 파일이 있는데
스키마가 틀리면 run 이 즉시 실패한다. 자세한 동작은 §6.2.1.
`runtime` 이 있으면 실제 동작 검증 게이트도 활성화된다 (§6.2.2).

프로젝트 지식은 별도 `<projectDir>/.auto-dev/feature-map.md` 에 둔다. 에이전트별 주입
범위와 크기 제한은 §5.0.1 을 따른다.

---

## 13. 프로젝트 레이아웃

```
auto-dev-ts/
├── run                               # 실행 wrapper (tsx src/cli.ts "$@")
├── evals/cases/                      # spec + fixture + checks + expected result
├── package.json / tsconfig.json
├── .env.example
├── README.md / README.ko.md
├── CLAUDE.md                         # 이 저장소에서 일하는 에이전트용 작업 규칙
├── docs/
│   ├── ARCHITECTURE.md               ← 본 문서
│   ├── templates/
│   │   └── feature-map.md            # 대상 백엔드 프로젝트 지식 템플릿
│   └── plans/
│       └── verification-roadmap.md   # 검증 중심 개선 로드맵 (Phase 0~7)
├── deploy/systemd/
│   └── auto-dev.service.in            # SSH 세션 독립 user service 템플릿
├── integrations/openclaw/skills/
│   └── auto-dev-spec/                  # OpenClaw user-invocable spec bridge
├── scripts/
│   ├── serve.sh                       # root 감지 시 비-root로 권한 강하
│   └── install-user-service.sh        # 현재 절대 경로로 user unit 설치
├── static/
│   ├── index.html                    # 대시보드
│   ├── chat.css                      # 플로팅 채팅 반응형 스타일
│   └── chat.js                       # localStorage 대화/기억 + NDJSON 스트림 UI
├── prompts/                          # 에이전트 시스템 프롬프트
│   ├── scaffold.system.md
│   ├── review.system.md
│   ├── review-correctness.system.md
│   ├── review-security.system.md
│   ├── review-perf.system.md
│   ├── review-style.system.md
│   ├── test.system.md
│   ├── cicd.system.md
│   ├── planner.system.md
│   ├── clarifier.system.md
│   ├── verifier.system.md
│   ├── checking-docs-before-commit.system.md
│   └── atomic-commit.system.md
├── src/
│   ├── cli.ts                        # Commander CLI 진입점 (13 서브커맨드)
│   ├── agents/
│   │   ├── index.ts                  # 레지스트리 + getAgent / listAgents
│   │   ├── scaffold.ts
│   │   ├── test.ts
│   │   ├── cicd.ts
│   │   ├── planner.ts
│   │   ├── clarifier.ts
│   │   └── review/
│   │       ├── index.ts              # 멀티-렌즈 오케스트레이터
│   │       └── lenses.ts             # 4개 서브에이전트 선언
│   ├── workflows/
│   │   ├── spec.ts                   # SpecWorkflow 파이프라인
│   │   ├── eval.ts                   # fixture 평가·모델 매트릭스·기준선 비교 (§6.2.5)
│   │   ├── verify-gate.ts            # 결정적 검증 단계 실행 + agent_run 기록 (§6.2.1)
│   │   ├── runtime-gate.ts           # 런타임 기동·동작 검증·정리 (§6.2.2)
│   │   ├── post-success-commit.ts    # docs skill → atomic commit 성공 후처리
│   │   ├── spec-session.ts           # clarifier 답변 재개 + plan 문서 기록
│   │   ├── clarification.ts          # slug · Q&A 합성 · plan 문서 렌더 (순수 함수)
│   │   └── from-issue.ts             # 이슈 1건 → 워크플로우 트리거
│   ├── integrations/
│   │   └── issue-tracker/            # 이슈·automation job 클라이언트 (+ Noop 폴백)
│   ├── llm/                          # LLM 프로바이더 seam (§4.2)
│   │   ├── types.ts                  # AgentRunner / Completer / ModelCatalog 인터페이스
│   │   ├── registry.ts               # AUTO_DEV_PROVIDER 기반 활성 프로바이더 선택
│   │   └── anthropic/                # Claude Code SDK 구현
│   │       ├── agent-runner.ts       # query() agentic 실행
│   │       ├── completer.ts          # 단발성 생성
│   │       ├── models.ts             # supportedModels() 디스커버리
│   │       └── message-reducer.ts    # SDK 메시지 → AgentEvent / AgentRunOutcome
│   ├── store/
│   │   ├── schema.sql                # DDL (IF NOT EXISTS)
│   │   ├── db.ts                     # better-sqlite3 싱글턴 + WAL pragma
│   │   ├── runs.ts                   # insertRun / updateRun / getRun / getStats
│   │   └── clarification.ts          # clarification_state 저장·조회 (재개용)
│   ├── lib/
│   │   ├── chat.ts                   # 채팅 검증·프롬프트·장기 기억 압축
│   │   ├── chat-context.ts           # 안전한 프로젝트 파일 발견·하이브리드 선택
│   │   ├── runner.ts                 # runAgent() — 공통 실행 파이프라인 (AgentRunner 소비)
│   │   ├── claude-auth.ts            # Claude CLI 상태 + SDK OAuth flow 관리자
│   │   ├── complete.ts               # 단발성 생성 래퍼 (Completer 소비)
│   │   ├── model-config.ts           # 모델/effort 선택 + 동적 목록 (ModelCatalog 소비)
│   │   ├── cost-guard.ts             # 일일 실행 가드 (메모리)
│   │   ├── circuit-breaker.ts        # rate-limit 회로차단기 (§10.2)
│   │   ├── run-events.ts             # SSE 이벤트 emitter (실행별)
│   │   ├── workspace.ts              # 프로젝트명 → cwd 해석 (경로 탈출 차단)
│   │   ├── project-config.ts         # .auto-dev/project.json 로드·검증 (§6.2)
│   │   ├── evidence.ts               # workflow runtime 증거 파일 읽기·쓰기 (§6.2.2)
│   │   ├── verify.ts                 # 검증 명령 실행 + 프로세스 그룹 정리 (§6.2.1)
│   │   ├── role-boundary.ts          # test 단계 역할 경계 사후 검사 (§6.2.1)
│   │   ├── prompt.ts                 # loadPrompt() — 파일 캐시
│   │   └── logger.ts                 # JSON 구조화 로그
│   ├── server/
│   │   ├── index.ts                  # startServer() — Hono + serve-static
│   │   └── routes.ts                 # HTTP API 엔드포인트 (§8.2)
│   └── schedule/
│       └── briefing.ts               # node-cron 일일 브리핑
└── data/                             # gitignore
    ├── auto-dev.db
    └── workspace/
```

대략 **TypeScript 73 파일(테스트 제외) / HTML 1 파일 / 프롬프트 14 파일**.

---

## 14. 빌드 / 실행

### 14.1 사전 조건

- Node.js 24+ (`nvm install 24`)
- Claude Code CLI 인증 완료 (`claude` 가 PATH 에 있어야 함)
- npm

### 14.2 설치 및 실행

```bash
npm install
cp .env.example .env

./run serve                         # HTTP API + 대시보드 (127.0.0.1:8080)
./run scaffold "User CRUD REST API"
./run spec docs/feature.md
./run spec docs/feature.md --steps scaffold,test,review

# SSH 세션과 분리해 상시 실행
npm run service:install
npm run service:start
npm run service:status
```

### 14.3 SSH 독립 실행 (`systemd --user`)

`scripts/install-user-service.sh`는 템플릿의 프로젝트 경로를 현재 checkout의 절대
경로로 치환해 `~/.config/systemd/user/auto-dev.service`에 설치하고 enable한다.
unit은 `scripts/serve.sh`를 foreground main process로 실행하며 `Restart=on-failure`,
`KillMode=control-group`을 적용한다. 따라서 SSH terminal/cgroup과 분리되고 provider
자식도 service cgroup에서 함께 관리된다.

로그아웃 뒤 user manager 유지에는 `loginctl enable-linger <user>`가 필요하다. 설치
스크립트는 linger를 검사해 비활성일 때 필요한 관리자 명령을 출력한다. 브라우저/SSH
터널 종료는 이미 시작된 background spec promise에 영향을 주지 않는다.

이 설계는 **SSH 연결 수명 문제**를 해결하지만 durable worker queue는 아니다. service
재시작·호스트 재부팅 시 메모리 안의 workflow 상태는 사라지고, DB 초기화가 남은
`RUNNING` 레코드를 `FAILED/server_restart`로 정리한다. crash-safe 재개에는 단계별
checkpoint + idempotency 정책 + 별도 worker lease가 추가로 필요하다.

### 14.4 OpenClaw Telegram bridge

Telegram 수신과 사용자 allowlist는 기존 OpenClaw gateway의 `main` 같은 계정이
담당한다. repo의 `auto-dev-spec` skill은 `127.0.0.1:8080`의 integration route를
호출하고 `202 + runId`만 받은 뒤 즉시 응답한다. 실제 workflow는 systemd user service
프로세스에서 계속 실행된다.

종료 알림은 `spec-session.finalize()`가 DB와 SSE 상태를 먼저 확정한 뒤
`openclaw message send --channel telegram --account <account>`를 호출한다. 알림 실패는
workflow 결과를 바꾸지 않는다. 대상 chat ID는 명시적 env가 없으면 해당 OpenClaw
계정의 `allowFrom[0]`에서 읽으며 bot token은 auto-dev가 읽거나 저장하지 않는다.

이 구성은 auto-dev 쪽 polling/webhook/public endpoint를 추가하지 않는다. Telegram
transport 방식(long polling 또는 webhook)은 OpenClaw의 기존 설정과 수명주기가
관리한다.

### 14.5 빌드 (프로덕션)

```bash
npm run build    # tsc → dist/
node dist/cli.js serve
```

### 14.6 네이티브 모듈 재빌드

Node.js 버전 업그레이드 후 `better-sqlite3` 가 `ERR_DLOPEN_FAILED` 오류를 내면:

```bash
npm rebuild better-sqlite3
```

---

## 15. 알려진 한계

| 영역 | 현재 |
|---|---|
| Planner 모드 | 고정 순서 기반. `PLAN: ... END.` 동적 파싱 미구현 (단, review/test 피드백 라우팅으로 재진입은 구현됨) |
| 재작업 루프 | review/test → planner·clarifier 라우팅 구현. 단 라우팅 대상(planner/clarifier) 선택은 모델 마커에 의존 |
| SSE | 실행 중 행은 라이브(§9.1). 단 종료된 실행 목록·통계는 여전히 10s 폴링 |
| 실행 가드 복원 | 재시작 시 카운터/회로 0 리셋. DB 누적 복원 없음 |
| spec 재시작 복구 | workflow opt-in dashboard spec의 안전한 순차 체크포인트만 지원. 팀/verify/runtime/전달 중단은 `RECOVERY_REQUIRED`; run 전용 worktree 미지원 |
| runShell 위험 패턴 | `bypassPermissions` 로 모든 Bash 명령 허용. 신뢰된 환경 필수 |
| review finding 구조화 | 자유 형식 출력. JSON dedup + verdict 파싱 없음 |
| 인증 | 없음. 127.0.0.1 바인딩만 |
| 이슈 카드 UI | issue-tracker API 는 연동되나 대시보드 카드 그리드 미구현 |
| 브라우저 검증 | Playwright 미구현 |
| 출력 파일 | `docs/output/<spec>-<ts>/` 디렉토리 생성 없음 |
| CI/CD | auto-dev-ts 자체 GitHub Actions 없음 |

---

## 16. 로드맵

> ✅ 완료: SSE 라이브 이벤트(§9.1), issue-tracker 연동(§8.2), rate-limit 회로차단기(§10.2),
> LLM 프로바이더 seam(§4.2).

| 우선순위 | 항목 | Java 버전 대응 |
|---|---|---|
| 高 | **runShell 위험 패턴 거부** | `WorkspaceTools.runShell` danger check |
| 中 | **Planner 모드** (동적 plan 파싱) | `Plan.parse()` + planner 모드 분기 |
| 中 | **review finding 구조화** | `ReviewFinding` 테이블 + dedup + verdict |
| 中 | **인증 (API key middleware)** | Spring Security 대응 |
| 中 | **실행 가드 DB 복원** | `DailyCostCircuitBreaker` DB 복원 |
| 低 | **이슈 카드 대시보드 UI** | issue-tracker API 연동(완료) 위 UI |
| 低 | **출력 디렉토리 + summary.md** | `docs/output/<spec>-<ts>/` |

---

## 17. 설계 결정 — 왜 이렇게?

### 17.1 왜 Claude Code SDK 인가?

- **비용**: OpenAI API per-token 과금 → 구독 플랜 정액제로 전환
- **도구**: SDK 가 파일 I/O / 쉘 / 서브에이전트를 내장 — `WorkspaceTools` 직접 구현 불필요
- **품질**: gpt-4o → Claude Sonnet/Opus 전환. 코드 이해·생성 품질 개선

### 17.2 왜 함수형 (클래스 없음)?

Java 의 `AbstractAgent` → 서브클래스 계층은 DI 프레임워크와 결합된 패턴.
TypeScript 에서 동일한 횡단 관심사는 `runAgent()` 함수 하나로 충분.
에이전트 함수가 `runAgent()` 를 호출하기만 하면 되므로 추상화 비용이 낮다.

### 17.3 왜 `permissionMode: 'bypassPermissions'`?

자동화 파이프라인에서 사람의 승인 대기가 끼어들면 파이프라인이 멈춘다.
내부 개발 환경(로컬 / 신뢰된 서버)에서만 운영하므로 허용.
외부 노출 환경이라면 `acceptEdits` 로 바꾸거나 별도 인증 추가 필요.

> **root로 실행 불가.** `bypassPermissions` 는 SDK 내부에서 CLI 플래그
> `--dangerously-skip-permissions` 로 변환되는데, Claude Code 는 root/sudo 에서 이
> 플래그를 거부한다("cannot be used with root/sudo privileges"). 따라서 root 로
> 서버/명령을 실행하면 모델 디스커버리·완성·에이전트 실행이 모두
> `Claude Code process exited with code 1` 로 실패한다. `scripts/serve.sh`
> (npm `serve:user`)가 root 감지 시 비-root 유저(`AUTO_DEV_RUN_AS_USER`, 기본
> `shin`)로 권한을 낮춰 실행한다. 컨테이너 한정 우회책으로 `IS_SANDBOX=1` 도 가능.
> SDK 실패 시 서브프로세스 stderr 가 버려지는 문제는 `llm/anthropic/cli-stderr.ts`
> 의 stderr 수집기로 보완해, 실제 원인을 에러 메시지에 덧붙인다.

### 17.4 왜 review 구조화 파싱 없이 시작했나?

Java 버전의 JSON dedup + deterministic verdict 는 구현 복잡도가 높다.
SDK `agents` 옵션이 이미 병렬 fan-out 을 처리하므로, 초기 버전은 Claude 에게
자유 형식 리포트를 맡기고 구조화는 추후 추가한다.

### 17.5 왜 better-sqlite3 (동기) 인가?

에이전트 실행은 이미 `async/await` 로 직렬화된다. DB write 를
비동기 Promise 로 감싸는 오버헤드 없이 동기 호출이 더 단순하고 안전하다.
(Java 버전의 `DB_WRITE_LOCK` synchronized 블록 대응.)

### 17.6 왜 Hono 인가?

Spring Boot Web 대비 오버헤드 없음. Hono 는 Request/Response 추상화가
Web API 표준(`fetch`)과 동일해 이식성이 높다. 필요 시 Cloudflare Workers /
Bun 으로 런타임 교체도 가능.

### 17.7 설계 범위와 한계 — 의도적 결정

"무엇을 안 만들었는가"도 중요한 설계 판단으로 보고, 자동화 범위를 명확히 정했습니다.

**Claude Code SDK 위임의 양면**

재시도, 컨텍스트 관리, 서브에이전트 실행을 SDK 에 맡겨 직접 구현 부담이 크게 줄었습니다.
반면 SDK API 변경(예: `query()` 시그니처, `AgentDefinition` 스펙, 허용 도구 목록)에
즉시 대응해야 하며, SDK 내부 실행 흐름을 직접 제어하거나 가시화하기 어렵습니다.

**의도적으로 만들지 않은 기능**

| 기능 | 현재 상태 | 이유 |
|---|---|---|
| 실시간 이벤트 스트림(SSE) | 구현됨. 실행 중 행은 SSE, 목록·통계는 10초 폴링 | 종료된 실행 목록/통계는 단순 폴링 유지 |
| 위험 Bash 패턴 거부 | 미구현 | `bypassPermissions` 사용 중 — 신뢰된 환경 전제 |
| review finding 구조화 | 자유 형식 출력 | JSON dedup + verdict 파싱은 구현 복잡도 高 |

**실제 배포 실행은 의도적으로 범위에서 제외**

`cicd` 에이전트는 GitHub Actions YAML, Dockerfile, 배포 manifest 등
재사용 가능한 **설정 파일 생성**까지를 담당합니다. 기본 동작은 CI-first 이고,
배포 manifest·릴리스 자동화는 명시적으로 CD 를 요청했을 때만 생성합니다.
`kubectl apply`, `gh workflow run` 등 실제 배포 명령 실행은 포함하지 않습니다.
배포 환경은 프로젝트마다 다르고 안전상 사람의 검토가 필요한 영역이기 때문입니다.

**보안 주의점**

`permissionMode: 'bypassPermissions'` 로 인해 에이전트가 확인 없이
모든 Bash 명령을 실행합니다. HTTP API 도 인증이 없어 `127.0.0.1` 바인딩만으로
보호합니다. **신뢰된 내부 환경에서만 사용**하도록 설계됐습니다.

**현실적인 자동화 범위**

스펙 하나를 입력으로 6단계 파이프라인
(`clarifier → planner → scaffold → test → review → cicd`)을 순서대로 실행하고,
`review` 단계는 4개 서브에이전트(정확성·보안·성능·스타일)를 병렬로 구동합니다.

단, 각 단계의 출력이 다음 단계의 입력이 되는 **단순 선형 연쇄** 구조입니다.
브랜치 조건, 실패 시 재시도 루프, 단계 간 상태 공유 같은 **복잡한 제어 흐름은
현재 미구현**입니다. "잘 정의된 스펙 하나를 자동화 파이프라인으로 처리"하는 수준으로
범위를 좁혔고, 그 범위 안에서는 안정적으로 동작합니다.

---

## 18. 변경 이력 요약

1. **TypeScript 프로젝트 초기화** — package.json, tsconfig, .env.example
2. **prompts/ 이전** — Java 버전 10개 시스템 프롬프트 복사
3. **store 레이어** — schema.sql, db.ts (WAL pragma), runs.ts CRUD
4. **lib 유틸리티** — logger, prompt loader (캐시), cost-guard, runner
5. **에이전트 구현** — scaffold, review(4렌즈), test, cicd, planner, clarifier
6. **SpecWorkflow** — 고정 시퀀스, workflowRunId 그룹화, VERDICT 조기 종료
7. **HTTP 서버** — Hono 7 엔드포인트, serve-static
8. **대시보드** — 바닐라 HTML/JS, 10초 폴링
9. **스케줄러** — node-cron 일일 브리핑
10. **SDK 패키지 수정** — `@anthropic-ai/claude-code` → `@anthropic-ai/claude-agent-sdk`
11. **README** (영문 + 한국어)
12. **ARCHITECTURE.md**
13. **운영 기능 확장** — SSE 라이브 이벤트(`run-events`), rate-limit 회로차단기,
    issue-tracker 연동(`work`/`/api/issues`), 프로젝트명 기반 워크스페이스,
    단발성 LLM 프록시(`/api/llm/complete`), 동적 모델 목록, 일일 한도 무제한 옵션
14. **LLM 프로바이더 seam** — SDK 직접 호출을 `src/llm/` (AgentRunner / Completer /
    ModelCatalog 인터페이스 + registry + anthropic 구현) 뒤로 격리. `AUTO_DEV_PROVIDER`
    로 프로바이더 선택. 인증/과금 방식 교체 가능
15. **문서 동기화** — 본 문서를 현재 구현에 맞춰 갱신 ← 현재
16. **자체 eval** — fixture 기반 모델 매트릭스 실행, 일일 한도 준수, 결과와 회귀 비교
17. **workflow checkpoint** — 명시적 opt-in dashboard spec의 lease 기반 안전 재개 및 복구 상태 노출

---

본 문서는 **현재 시점의 스냅샷** 입니다. 실제 코드와 어긋날 수 있으므로
설계 의도는 본 문서, 정확한 동작은 소스를 참고하세요.
