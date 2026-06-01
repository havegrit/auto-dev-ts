# auto-dev-ts — 시스템 아키텍처 문서

> 본 문서는 현재까지 구현된 `auto-dev-ts` 의 **구조·동작 원리·설계 결정** 을 정리한
> 기술 문서입니다. 사용 방법은 [`README.md`](../README.md) /
> [`README.ko.md`](../README.ko.md) 를 참고하세요.
>
> auto-dev-ts 는 [auto-dev (Java)](https://github.com/havegrit/auto-dev) 를
> TypeScript 로 재작성한 버전입니다. LLM API 직접 호출 → **Claude Code SDK 위임** 으로
> 전환해 per-token 과금을 구독 플랜 비용으로 대체한 것이 핵심 변경점입니다.

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
- ✅ SpecWorkflow 파이프라인 (clarifier → planner → scaffold → test → review → cicd)
- ✅ HTTP API + 웹 대시보드
- ⚠️ SSE 라이브 이벤트 — 미구현
- ⚠️ Test-pass loop — 미구현 (Java 버전에는 있음)
- ⚠️ Planner 모드 (동적 plan 파싱) — 미구현 (고정 시퀀스만)
- ⚠️ 브라우저 검증 (Playwright) — 미구현

현실적 자율 범위: **잘 정의된 좁은 task 한 건을 Claude Code 세션 1개로 처리** 수준.

---

## 2. 기술 스택

| 영역 | 선택 | 한 줄 근거 |
|---|---|---|
| 언어/런타임 | **TypeScript + Node.js 22** | Claude Code SDK 가 Node.js 기반 |
| LLM 런타임 | **Claude Code SDK (`@anthropic-ai/claude-agent-sdk`)** | Claude Code CLI 를 프로그래밍으로 제어, 구독 플랜 사용 |
| HTTP 서버 | **Hono + `@hono/node-server`** | 경량, Spring Boot 대비 오버헤드 없음 |
| CLI | **Commander v12** | Picocli 대응, Node.js 생태계 표준 |
| 영속화 | **better-sqlite3 v9** | 동기 API, 단일 사용자 / 파일 1개 |
| 스케줄러 | **node-cron v3** | `@Scheduled` 대응 |
| 빌드/실행 | **tsx (dev) + tsc (prod)** | TypeScript 직접 실행, Gradle 불필요 |

---

## 3. 큰 그림

```
                ┌──────────────────────────────────────────────────┐
                │  Triggers                                         │
                │  • CLI (Commander)   • HTTP API (POST /api/...)  │
                │  • node-cron         • Future: webhook            │
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
                         │ 3. query(prompt, options)           │
                         │    ← @anthropic-ai/claude-agent-sdk │
                         │    ← Claude Code CLI subprocess     │
                         │ 4. collect ResultMessage            │
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

           Each agent → query(prompt, { cwd, allowedTools, permissionMode })
                          │
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
| 3 | `query(prompt, options)` — Claude Code SDK 호출 (async generator) |
| 4 | `ResultMessage` 수집 — output + token usage |
| 5 | `costGuard.recordRun()` |
| 6 | `updateRun(DONE | FAILED)` — DB row 업데이트 |

에이전트 함수는 `runAgent()` 를 호출하기만 하면 됨 → 횡단 관심사 자동 적용.

Java 버전 대비 **제거된 책임**:
- 토큰 budget clamp (SDK 가 컨텍스트 관리)
- 429 재시도 (SDK 내부 처리)
- SSE 브로드캐스트 (미구현)

### 4.2 `query()` — Claude Code SDK 진입점

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const msg of query(prompt, {
  allowedTools: ['Read', 'Write', 'Bash'],
  permissionMode: 'bypassPermissions',
  cwd: workspaceDir,
})) {
  if (msg.type === 'result') {
    output = msg.result;
  }
}
```

`query()` 는 Claude Code CLI 를 subprocess 로 구동하고 메시지를 스트리밍한다.
주요 옵션:

| 옵션 | 타입 | 설명 |
|---|---|---|
| `allowedTools` | `string[]` | 에이전트가 사용할 수 있는 도구 (`Read`, `Write`, `Bash`, `Agent`) |
| `permissionMode` | string | `bypassPermissions` — 모든 권한 승인 없이 자동 실행 |
| `cwd` | string | 에이전트 작업 디렉토리 (모든 파일 I/O 기준점) |
| `agents` | `{name, description}[]` | 서브에이전트 선언 (병렬 fan-out) |

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

- 도구: `Read`, `Write`, `Bash` — 테스트 파일 작성 + 실행
- Java 버전의 test-pass loop (`[TESTS: PASS|FAIL|BLOCKED]` 마커 재시도) 미구현

### 5.6 cicd

- 도구: `Read`, `Write`
- GitHub Actions YAML, Dockerfile, 배포 manifest 생성

---

## 6. 워크플로우 오케스트레이션 (`SpecWorkflow`)

### 6.1 진입

```typescript
// src/workflows/spec.ts
export async function runSpec(specContent: string, opts: SpecOptions): Promise<SpecResult>
```

### 6.2 고정 시퀀스 모드

현재 유일한 모드 (Java 의 Planner 모드 동적 plan 파싱 미구현):

```
for step in [clarifier, planner, scaffold, test, review, cicd] (steps 필터 적용):
    result = await agent(input, { workflowRunId, triggerSource })
    if step == 'planner' && result.output:
        input = result.output   # planner 출력이 이후 단계의 입력
    if step == 'review' && result.output.includes('[VERDICT: SHIP]'):
        break                   # 조기 종료
```

- `--steps` 로 특정 단계만 실행 가능
- `--iterations` 로 전체 사이클 N회 반복 (Java 버전의 refinement iteration)
- 모든 자식 실행은 동일한 `workflowRunId` 로 묶여 DB 에서 추적 가능

### 6.3 Java 버전 대비 미구현 항목

| 기능 | Java | TypeScript |
|---|---|---|
| Planner 모드 | `Plan.parse()` → 동적 step 목록 | 미구현 (고정 시퀀스만) |
| Test-pass loop | attempt 1..3, `[TESTS: FAIL]` 재시도 | 미구현 |
| summary.md 출력 | 토큰·비용·소요시간 표 | 미구현 |
| 출력 디렉토리 | `docs/output/<spec>-<ts>/` | 미구현 |

---

## 7. 영속화

### 7.1 SQLite — `agent_run` 테이블

```sql
CREATE TABLE agent_run (
  id            TEXT PRIMARY KEY,      -- UUID
  agent_name    TEXT NOT NULL,         -- scaffold / review / test / cicd / planner / clarifier
  input         TEXT,                  -- 에이전트가 받은 프롬프트
  output        TEXT,                  -- 에이전트 응답
  tokens_in     INTEGER DEFAULT 0,
  tokens_out    INTEGER DEFAULT 0,
  status        TEXT NOT NULL,         -- RUNNING / DONE / FAILED / BLOCKED
  started_at    TEXT NOT NULL,         -- ISO 8601
  duration_ms   INTEGER DEFAULT 0,
  trigger_source TEXT,                 -- cli / api / schedule / workflow
  trigger_detail TEXT,
  workflow_run_id TEXT                 -- 워크플로우 내 자식 호출 그룹화
);
```

Java 버전 대비 제거된 컬럼:
- `cost_usd` — 구독 플랜이므로 per-call 비용 없음

`review_finding` 테이블 (구조화 finding 영속화) 미구현 — Java 버전의 multi-lens JSON dedup 파싱 생략으로 불필요.

### 7.2 파일 산출물

```
data/
├── auto-dev.db          # SQLite (gitignore)
└── workspace/           # 에이전트 cwd (gitignore)
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
            --iterations 2                   # 반복

./run status                                  # 에이전트 목록 + 실행 가드 통계
./run serve                                   # HTTP API + 대시보드 + 스케줄러
./run daemon                                  # serve 와 동일 (alias)
```

입력 감지: `existsSync(input)` 가 true 이면 파일 읽기, 아니면 인라인 문자열.

### 8.2 HTTP API (`serve` 모드)

| Method | Path | 설명 |
|---|---|---|
| `GET` | `/api/status` | 에이전트 목록 + 실행 가드 통계 |
| `POST` | `/api/agents/:name` | 단일 에이전트 실행 `{ input }` |
| `POST` | `/api/clarify` | clarifier 실행 `{ input }` |
| `POST` | `/api/specs` | SpecWorkflow 실행 `{ content, steps?, iterations? }` |
| `GET` | `/api/runs?limit=N` | 최근 N개 실행 (cap 없음) |
| `GET` | `/api/runs/:id` | 단일 실행 상세 |
| `GET` | `/api/stats` | 집계 통계 (total, today, byStatus, byAgent) |

Java 버전 대비 미구현:
- `GET /api/events` — SSE 스트림
- `GET /api/runs/:id/findings` — review finding 구조화 조회
- `GET /api/jira/issues` — Jira 연동

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
- 10초마다 `/api/status`, `/api/stats`, `/api/runs` 자동 폴링
- SSE 미구현 → 폴링 방식

### 9.2 Java 버전 대비 미구현

- SSE 라이브 인디케이터
- Jira 이슈 카드 그리드
- Plan / Plan & Run 버튼
- Per-agent summary 테이블
- 통화 토글 (USD ↔ KRW)
- Run 행 클릭 상세 펼치기 (현재 미리보기만)

---

## 10. 리질리언스

### 10.1 일일 실행 가드 (`costGuard`)

- 일일 100회 초과 시 BLOCKED 즉시 반환
- 자정 (`Asia/Seoul`) 자동 리셋
- DB 재시작 시 카운터 0 (비휘발성 복원 미구현)

### 10.2 SDK 내장 안전망

Java 버전에서 직접 구현했던 아래 항목들을 SDK 가 처리:

| 기능 | Java (자체 구현) | TypeScript (SDK 위임) |
|---|---|---|
| 429 재시도 | `executeWithRetry` — 메시지 파싱 + sleep | SDK 내부 |
| 토큰 budget | `PromptBudget.clamp` — head+marker+tail | SDK 컨텍스트 관리 |
| 세션 관리 | N/A (stateless) | SDK 자동 |

### 10.3 Verdict 기반 조기 종료

| Verdict | 발생 | 효과 |
|---|---|---|
| `[VERDICT: SHIP]` | review 출력 | SpecWorkflow iteration 루프 종료 |

`[VERDICT: BLOCKED]`, `[VERDICT: NEEDS-WORK]` 구분 및 Test-pass loop 마커 (`[TESTS: PASS|FAIL|BLOCKED]`) 처리 미구현.

---

## 11. 보안

### 11.1 Claude Code 인증

- `claude` CLI 가 사전 인증된 상태여야 동작
- 별도 API 키 불필요 — Claude.ai 구독 플랜 사용
- 인증 정보는 Claude Code 자체 관리 (`~/.claude/`)

### 11.2 워크스페이스 격리

- 모든 에이전트의 `cwd` 를 `AUTO_DEV_WORKSPACE_ROOT` 로 고정
- SDK `permissionMode: 'bypassPermissions'` — 확인 없이 자동 실행
- Java 버전의 `runShell` 위험 패턴 거부 (sudo / rm -rf / curl 등) 미구현
  → 에이전트가 위험한 명령을 실행할 수 있음. **신뢰된 환경에서만 사용 권장**

### 11.3 HTTP API

- 인증 없음. 기본 바인딩 `127.0.0.1` 으로만 보호
- `AUTO_DEV_BIND_ADDR=0.0.0.0` 외부 노출 시 별도 인증 추가 필요

---

## 12. 설정

### 12.1 환경변수

| 키 | 기본값 | 설명 |
|---|---|---|
| `AUTO_DEV_WORKSPACE_ROOT` | `./data/workspace` | 에이전트 cwd |
| `AUTO_DEV_DB_PATH` | `./data/auto-dev.db` | SQLite 경로 |
| `AUTO_DEV_BIND_ADDR` | `127.0.0.1` | HTTP 바인드 주소 |
| `AUTO_DEV_BIND_PORT` | `8080` | HTTP 포트 |
| `AUTO_DEV_DAILY_RUN_LIMIT` | `100` | 일일 에이전트 실행 횟수 한도 |
| `AUTO_DEV_WORKLOG_BRIEFING_ENABLED` | `false` | 일일 브리핑 스케줄러 활성 |
| `AUTO_DEV_WORKLOG_BRIEFING_CRON` | `0 9 * * *` | 브리핑 크론 표현식 |

---

## 13. 프로젝트 레이아웃

```
auto-dev-ts/
├── run                               # 실행 wrapper (tsx src/cli.ts "$@")
├── package.json / tsconfig.json
├── .env.example
├── README.md / README.ko.md
├── docs/
│   └── ARCHITECTURE.md               ← 본 문서
├── static/
│   └── index.html                    # 대시보드 (바닐라 HTML/JS)
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
│   └── clarifier.system.md
├── src/
│   ├── cli.ts                        # Commander CLI 진입점 (9 서브커맨드)
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
│   │   └── spec.ts                   # SpecWorkflow 파이프라인
│   ├── store/
│   │   ├── schema.sql                # DDL (IF NOT EXISTS)
│   │   ├── db.ts                     # better-sqlite3 싱글턴 + WAL pragma
│   │   └── runs.ts                   # insertRun / updateRun / getRun / getStats
│   ├── lib/
│   │   ├── runner.ts                 # runAgent() — 공통 실행 파이프라인
│   │   ├── cost-guard.ts             # 일일 실행 가드 (메모리)
│   │   ├── prompt.ts                 # loadPrompt() — 파일 캐시
│   │   └── logger.ts                 # JSON 구조화 로그
│   ├── server/
│   │   ├── index.ts                  # startServer() — Hono + serve-static
│   │   └── routes.ts                 # 7개 API 엔드포인트
│   └── schedule/
│       └── briefing.ts               # node-cron 일일 브리핑
└── data/                             # gitignore
    ├── auto-dev.db
    └── workspace/
```

대략 **TypeScript 16 파일 / HTML 1 파일 / 프롬프트 10 파일**.

---

## 14. 빌드 / 실행

### 14.1 사전 조건

- Node.js 22+ (`nvm install 22`)
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
```

### 14.3 빌드 (프로덕션)

```bash
npm run build    # tsc → dist/
node dist/cli.js serve
```

### 14.4 네이티브 모듈 재빌드

Node.js 버전 업그레이드 후 `better-sqlite3` 가 `ERR_DLOPEN_FAILED` 오류를 내면:

```bash
npm rebuild better-sqlite3
```

---

## 15. 알려진 한계

| 영역 | 현재 |
|---|---|
| Planner 모드 | 고정 시퀀스만. `PLAN: ... END.` 동적 파싱 미구현 |
| Test-pass loop | 단일 attempt. 실패 시 재시도 없음 |
| SSE | 폴링(10s) 방식. 실시간 이벤트 스트림 없음 |
| 실행 가드 복원 | 재시작 시 카운터 0 리셋. DB 누적 복원 없음 |
| runShell 위험 패턴 | `bypassPermissions` 로 모든 Bash 명령 허용. 신뢰된 환경 필수 |
| review finding 구조화 | 자유 형식 출력. JSON dedup + verdict 파싱 없음 |
| 인증 | 없음. 127.0.0.1 바인딩만 |
| Jira 연동 | 인터페이스 없음 (Java 버전 있음) |
| 브라우저 검증 | Playwright 미구현 |
| 출력 파일 | `docs/output/<spec>-<ts>/` 디렉토리 생성 없음 |
| CI/CD | auto-dev-ts 자체 GitHub Actions 없음 |

---

## 16. 로드맵

| 우선순위 | 항목 | Java 버전 대응 |
|---|---|---|
| 高 | **SSE 라이브 이벤트** | `AgentEventBroadcaster` |
| 高 | **Test-pass loop** | `runTestStepWithLoop` |
| 高 | **runShell 위험 패턴 거부** | `WorkspaceTools.runShell` danger check |
| 中 | **Planner 모드** (동적 plan 파싱) | `Plan.parse()` + planner 모드 분기 |
| 中 | **review finding 구조화** | `ReviewFinding` 테이블 + dedup + verdict |
| 中 | **인증 (API key middleware)** | Spring Security 대응 |
| 中 | **실행 가드 DB 복원** | `DailyCostCircuitBreaker` DB 복원 |
| 低 | **Jira 연동** | `JiraIssueTrackerHook` |
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
12. **ARCHITECTURE.md** ← 현재

---

본 문서는 **현재 시점의 스냅샷** 입니다. 실제 코드와 어긋날 수 있으므로
설계 의도는 본 문서, 정확한 동작은 소스를 참고하세요.
