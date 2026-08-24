/** 한 에이전트 실행에 필요한 입력. dispatch가 system+input을 합쳐 prompt로 넘긴다. */
export interface AgentRunRequest {
  prompt: string;
  cwd: string;
  tools: string[];
  subagents?: Record<string, unknown>;
  model: string;
  effort?: string;
  /** generic은 Codex 공통 결과 계약을 추가하고, raw는 agent 고유 출력 계약을 보존한다. */
  resultMode?: 'generic' | 'raw';
  /** provider 실행과 하위 프로세스를 실제 중단하는 controller. */
  abortController?: AbortController;
}

/** 프로바이더-무관 스트리밍 이벤트. 기존 emitRunEvent / circuit-breaker 신호와 1:1. */
export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; name: string; input: string }
  | { kind: 'tool_result'; content: string }
  | { kind: 'usage'; tokensIn: number; tokensOut: number }
  | { kind: 'rate_limit'; resetsAt?: number; retryDelayMs?: number };

/** 한 에이전트 실행의 최종 결과. */
export interface AgentRunOutcome {
  status: 'success' | 'error';
  output: string;
  rawOutput?: string;
  changedFiles?: string[];
  tokensIn: number;
  tokensOut: number;
  numTurns: number;
  stopReason: string | null;
  errorType?: string;
  permissionDenials?: string[];
  errors?: string[];
}

/** 도구를 쓰는 agentic 실행. 이벤트를 콜백으로 흘려보내고 최종 결과를 반환한다. */
export interface AgentRunner {
  run(req: AgentRunRequest, onEvent: (e: AgentEvent) => void): Promise<AgentRunOutcome>;
}

export interface CompleteRequest {
  system?: string;
  message: string;
  json?: boolean;
  model?: string;
  signal?: AbortSignal;
}

/** 도구 없는 단발성 텍스트 생성. */
export interface Completer {
  complete(req: CompleteRequest): Promise<string>;
  /** 가능한 경우 프로바이더 토큰 델타를 전달한다. 반환값은 최종 전체 텍스트다. */
  stream?(req: CompleteRequest, onText: (text: string) => void): Promise<string>;
}

export interface ModelSpec {
  id: string;
  provider?: string;
  providerModel?: string;
  displayName: string;
  description?: string;
  effortLevels: string[];
}

/** 모델 디스커버리. */
export interface ModelCatalog {
  listModels(): Promise<ModelSpec[]>;
}
