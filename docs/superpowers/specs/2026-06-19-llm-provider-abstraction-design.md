# LLM 프로바이더 추상화 (seam) 설계

- 날짜: 2026-06-19
- 상태: 승인됨 (구현 계획 대기)
- 범위: **이음새(seam)만 도입** — Provider 인터페이스를 정의하고 Anthropic을 유일 구현체로 둔다. 실제 2nd 프로바이더 구현은 이번 범위 밖.

## 배경 / 동기

auto-dev-ts는 `@anthropic-ai/claude-agent-sdk`의 `query()`로 Claude Code에 작업을 위임한다.
Anthropic의 구독 빌링 정책(2026-06-15 예정이었다가 유예된 변경: Agent SDK/`claude -p` 사용을
별도 크레딧·API 요금으로 분리)을 고려할 때, 코드가 단일 SDK 호출에 직결되어 있으면 프로바이더
교체 비용이 크다. 인증(구독 OAuth ↔ API 키) 전환은 SDK가 환경변수로 흡수하므로 코드 변경이
거의 필요 없지만, **프로바이더 자체 교체는 현재 전혀 추상화되어 있지 않다.**

`query()` 직접 호출은 세 곳에 존재한다:

1. `src/lib/runner.ts` — 도구를 쓰는 agentic 실행 루프(스트리밍 이벤트, rate-limit/circuit-breaker, 토큰 집계).
2. `src/lib/complete.ts` — 도구 없는 단발성 텍스트 생성.
3. `src/lib/model-config.ts` — `supportedModels()` 모델 디스커버리.

이 셋 사이에 인터페이스를 끼워, 소비처를 고치지 않고 구현만 교체할 수 있는 이음새를 만든다.

## 비목표 (Non-goals)

- 비-Anthropic 프로바이더(OpenAI 등)의 실제 구현. (인터페이스가 이를 **수용**하도록만 설계)
- agentic 도구 루프를 프로바이더-중립으로 재구현하는 일(자체 mini Agent SDK). 이것은 별도의
  대규모 작업이며, 본 seam은 그 작업이 "구현체 하나 추가"로 수렴하도록 길을 닦을 뿐이다.
- 외부 동작·환경변수·대시보드 SSE·DB 스키마 변경. **이번 작업은 순수 리팩터링이다.**

## 설계

### 디렉토리 구조

```
src/llm/
  types.ts            # AgentRunner, Completer, ModelCatalog 인터페이스 + 공용 타입
  registry.ts         # 활성 프로바이더 선택 (getAgentRunner / getCompleter / getModelCatalog)
  anthropic/
    agent-runner.ts   # query() 기반 AgentRunner 구현 (runner.ts의 query 루프를 이전)
    completer.ts      # query() 기반 Completer 구현 (complete.ts 본문을 이전)
    models.ts         # supportedModels() 기반 ModelCatalog 구현 (model-config의 로딩 본문 이전)
```

### 인터페이스 (`src/llm/types.ts`)

도구를 쓰는 무거운 경로(`AgentRunner`)와 프로바이더-중립의 가벼운 경로(`Completer`)를
**별도 인터페이스로 분리**한다. 두 경로의 교체 난이도 차이를 타입 레벨에서 솔직하게 드러낸다.

```typescript
// 도구를 쓰는 agentic 실행. 스트리밍 이벤트를 공통 타입으로 정규화해 콜백으로 흘려보낸다.
export interface AgentRunner {
  run(req: AgentRunRequest, onEvent: (e: AgentEvent) => void): Promise<AgentRunOutcome>;
}

// 도구 없는 단발성 텍스트 생성. 교체가 쉬운 경로.
export interface Completer {
  complete(req: CompleteRequest): Promise<string>;
}

// 모델 디스커버리.
export interface ModelCatalog {
  listModels(): Promise<ModelSpec[]>;
}

export interface AgentRunRequest {
  prompt: string;          // 시스템+입력이 합쳐진 최종 프롬프트 (dispatch가 조립)
  cwd: string;
  tools: string[];         // 역할 경계(AGENT_SPECS) — 구현체가 프로바이더 형식으로 강제
  subagents?: Record<string, unknown>; // review 렌즈 등
  model: string;
  effort?: string;         // 모델이 effort 미지원이면 undefined
}

// 공통 이벤트 — 프로바이더 무관. 기존 emitRunEvent / circuit-breaker 신호와 1:1.
export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; name: string; input: string }
  | { kind: 'tool_result'; content: string }
  | { kind: 'rate_limit'; resetsAt?: number; retryDelayMs?: number };

export interface AgentRunOutcome {
  status: 'success' | 'error';
  output: string;
  tokensIn: number;
  tokensOut: number;
  numTurns: number;
  stopReason: string | null;
  errorType?: string;          // error_max_turns | error_max_budget_usd | no_result | exception ...
  permissionDenials?: string[];
}

export interface CompleteRequest {
  system?: string;
  message: string;
  json?: boolean;
  model?: string;
}

// model-config.ts의 ModelSpec과 동일 형태(중복 정의 대신 재사용/이동 여부는 구현 시 결정).
export interface ModelSpec {
  id: string;
  displayName: string;
  description?: string;
  effortLevels: string[];
}
```

### 레지스트리 (`src/llm/registry.ts`)

활성 프로바이더를 한 곳에서 결정한다. 환경변수 `AUTO_DEV_PROVIDER`(기본 `anthropic`)로 선택.

```typescript
const PROVIDER = process.env.AUTO_DEV_PROVIDER ?? 'anthropic';

export function getAgentRunner(): AgentRunner { /* PROVIDER → 구현체, 미지원이면 throw */ }
export function getCompleter(): Completer { /* 동일 */ }
export function getModelCatalog(): ModelCatalog { /* 동일 */ }
```

- 현재는 `anthropic`만 등록. 알 수 없는 값이면 명확한 에러로 즉시 실패(fail-fast).

### 소비처 변경

**`src/lib/runner.ts`** — `_execute`의 `query()` 루프와 SDK 메시지 파싱을 `AnthropicAgentRunner`로
이전. `_execute`는 다음만 남는다(프로바이더 무관 오케스트레이션):

- `getAgentRunner().run(req, onEvent)` 호출.
- `onEvent` 콜백에서 기존 로직 유지: `text`/`tool_call`/`tool_result` → `emitRunEvent`,
  `rate_limit` → `circuitBreaker.openUntil()` / `openForFallback()`.
- 반환된 `AgentRunOutcome`으로 `updateRun`(DONE/FAILED), `costGuard.recordRun()`,
  로깅, `emitRunEvent` status, `closeEmitter`.
- 기존 `_initRun`(circuit/cost-guard 게이트, DB insert) 흐름은 불변.

**`src/lib/complete.ts`** — JSON 지시문 합성 로직과 `query()` 본문을 `AnthropicCompleter`로 이전.
`complete()`는 `getCompleter().complete(req)` 위임만 남긴다. `parseJsonLoose`는 그대로 유지.

**`src/lib/model-config.ts`** — `loadModelsFromCli()`의 `query().supportedModels()` 본문을
`AnthropicModelCatalog`로 이전하고 `getModelCatalog().listModels()` 위임으로 교체.
`FALLBACK_MODELS`, `reconcileSelection`, effort 검증, 선택 상태(`currentModel`/`currentEffort`)
관리는 **프로바이더 무관 로직이므로 `model-config.ts`에 그대로 유지**한다.

### 에러 처리

- `AnthropicAgentRunner`는 스트림이 `result` 없이 종료되거나 예외 발생 시 `outcome.status='error'`로
  정규화한다(기존 `no_result` / `exception` 처리와 동치). 소비처의 try/catch·FAILED 기록 흐름 보존.
- `AnthropicCompleter`는 실패 subtype에서 기존과 동일하게 throw.
- 레지스트리는 미지원 프로바이더에 대해 fail-fast.

### 테스트 전략

- seam 도입의 부수입: **fake 구현체**로 `runner.ts` 오케스트레이션(circuit-breaker 작동,
  cost-guard 차단, DONE/FAILED 및 토큰 기록)을 SDK·네트워크 없이 단위 테스트 가능.
- `AnthropicAgentRunner`의 SDK 메시지 → `AgentEvent`/`AgentRunOutcome` 매핑을 가짜 메시지
  배열로 테스트(텍스트/tool_use/tool_result/rate_limit/result success/error/no_result).
- 회귀 보증: 환경변수·SSE 이벤트 형태·DB 기록 값이 리팩터링 전후로 동일함을 확인.

## 동작 보존 보증

순수 리팩터링이다. 외부 동작, 환경변수(`AUTO_DEV_MODEL`/`AUTO_DEV_EFFORT`/`AUTO_DEV_WORKSPACE_ROOT`),
대시보드 SSE 이벤트, DB 스키마, CLI 명령 모두 불변. 변경되는 것은 "코드를 어디서 호출하느냐"뿐이며
Anthropic이 유일 구현체로 남는다. 신규 환경변수 `AUTO_DEV_PROVIDER`는 기본값 `anthropic`으로
기존 동작과 동일하다.

## 향후 확장 (참고, 비목표)

비-Anthropic agentic 프로바이더를 추가하려면 해당 구현체가 다음을 직접 메꿔야 한다:
도구 사용 루프, 도구 구현체(Read/Write/Bash/서브에이전트)와 권한 경계 강제, 서브에이전트
오케스트레이션, 스트리밍 이벤트 정규화, rate-limit/재시도/usage 매핑, 모델 디스커버리.
`Completer` 경로는 프로바이더 간 차이가 작아 추가가 쉽다. 본 seam은 이 확장이 "인터페이스
구현체 작성 + 레지스트리 등록"으로 국한되도록 만든다.
