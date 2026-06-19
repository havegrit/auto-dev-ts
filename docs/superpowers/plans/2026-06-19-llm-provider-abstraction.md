# LLM Provider Abstraction (seam) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert a provider seam between auto-dev's three `query()` call sites and the `@anthropic-ai/claude-agent-sdk`, so the provider can be swapped by adding an implementation rather than editing consumers.

**Architecture:** Define two consumer-facing interfaces — `AgentRunner` (heavy, tool-using, streaming) and `Completer` (light, one-shot text) — plus `ModelCatalog`. Anthropic is the sole implementation. A `registry` selects the active provider via `AUTO_DEV_PROVIDER` (default `anthropic`). The error-prone SDK-message → normalized-event mapping is extracted as a **pure reducer** so it is unit-testable without mocking the SDK. This is a pure refactor: external behavior, env vars, dashboard SSE, and DB schema are unchanged.

**Tech Stack:** TypeScript (ESM, NodeNext), tsx, `@anthropic-ai/claude-agent-sdk` 0.3.162, vitest (added by this plan), better-sqlite3.

## Global Constraints

- Node `>=24`; ESM (`"type": "module"`) — relative imports MUST use the `.js` extension even from `.ts` sources (NodeNext).
- TypeScript `strict: true`. No `any` in new public signatures except where wrapping untyped SDK messages (mark with a comment).
- Pure refactor: do NOT change env var names (`AUTO_DEV_MODEL`, `AUTO_DEV_EFFORT`, `AUTO_DEV_WORKSPACE_ROOT`, `AUTO_DEV_DB_PATH`), the SSE event shapes emitted by `emitRunEvent`, the DB schema, or CLI commands.
- New env var `AUTO_DEV_PROVIDER` defaults to `anthropic` so existing behavior is identical.
- Commit conventions (jay's atomic-commit): `prefix: lowercase imperative title`, one logical change per commit, NO `Co-Authored-By` trailer.
- Run a single test file with: `npx vitest run <path>`. Run all: `npx vitest run`.

---

### Task 1: Vitest setup + seam interfaces + pure message reducer

This task lays the test harness, defines the interface types, and implements the
one piece with real logic — the SDK-message → normalized-event reducer — fully TDD'd
with plain objects (no SDK, no DB, no mocks).

**Files:**
- Modify: `package.json` (add vitest devDependency + `test` script)
- Create: `vitest.config.ts`
- Create: `src/llm/types.ts`
- Create: `src/llm/anthropic/message-reducer.ts`
- Test: `src/llm/anthropic/message-reducer.test.ts`

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces:
  - `src/llm/types.ts` exports: `AgentRunner`, `Completer`, `ModelCatalog`, `AgentRunRequest`, `AgentEvent`, `AgentRunOutcome`, `CompleteRequest`, `ModelSpec` (signatures below).
  - `src/llm/anthropic/message-reducer.ts` exports:
    - `interface OutcomeAccumulator { tokensIn: number; tokensOut: number }`
    - `function newAccumulator(): OutcomeAccumulator`
    - `function reduceMessage(msg: any, acc: OutcomeAccumulator, onEvent: (e: AgentEvent) => void): AgentRunOutcome | null` — emits events as side effects; returns a terminal outcome only for a `result` message, else `null`.

- [ ] **Step 1: Add vitest and a test script**

Edit `package.json` — add to `devDependencies` and `scripts`:

```json
"scripts": {
  "test": "vitest run"
},
"devDependencies": {
  "vitest": "^2.1.0"
}
```

Then install:

```bash
npm install
```

- [ ] **Step 2: Create vitest config**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Create the seam interfaces**

Create `src/llm/types.ts`:

```typescript
/** 한 에이전트 실행에 필요한 입력. dispatch가 system+input을 합쳐 prompt로 넘긴다. */
export interface AgentRunRequest {
  prompt: string;
  cwd: string;
  tools: string[];
  subagents?: Record<string, unknown>;
  model: string;
  effort?: string;
}

/** 프로바이더-무관 스트리밍 이벤트. 기존 emitRunEvent / circuit-breaker 신호와 1:1. */
export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; name: string; input: string }
  | { kind: 'tool_result'; content: string }
  | { kind: 'rate_limit'; resetsAt?: number; retryDelayMs?: number };

/** 한 에이전트 실행의 최종 결과. */
export interface AgentRunOutcome {
  status: 'success' | 'error';
  output: string;
  tokensIn: number;
  tokensOut: number;
  numTurns: number;
  stopReason: string | null;
  errorType?: string;
  permissionDenials?: string[];
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
}

/** 도구 없는 단발성 텍스트 생성. */
export interface Completer {
  complete(req: CompleteRequest): Promise<string>;
}

export interface ModelSpec {
  id: string;
  displayName: string;
  description?: string;
  effortLevels: string[];
}

/** 모델 디스커버리. */
export interface ModelCatalog {
  listModels(): Promise<ModelSpec[]>;
}
```

- [ ] **Step 4: Write the failing reducer test**

Create `src/llm/anthropic/message-reducer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { reduceMessage, newAccumulator } from './message-reducer.js';
import type { AgentEvent } from '../types.js';

function collect(msgs: any[]) {
  const events: AgentEvent[] = [];
  const acc = newAccumulator();
  let outcome = null;
  for (const m of msgs) {
    const r = reduceMessage(m, acc, (e) => events.push(e));
    if (r) outcome = r;
  }
  return { events, outcome, acc };
}

describe('reduceMessage', () => {
  it('emits text and tool_call from an assistant message', () => {
    const { events } = collect([
      { type: 'assistant', message: { content: [
        { type: 'text', text: '  hello  ' },
        { type: 'tool_use', name: 'Read', input: { path: 'a.ts' } },
      ] } },
    ]);
    expect(events).toEqual([
      { kind: 'text', text: 'hello' },
      { kind: 'tool_call', name: 'Read', input: '{"path":"a.ts"}' },
    ]);
  });

  it('skips empty text blocks', () => {
    const { events } = collect([
      { type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } },
    ]);
    expect(events).toEqual([]);
  });

  it('emits tool_result content', () => {
    const { events } = collect([
      { type: 'tool_result', content: [{ text: 'file body' }] },
    ]);
    expect(events).toEqual([{ kind: 'tool_result', content: 'file body' }]);
  });

  it('maps a rejected rate_limit_event with resetsAt', () => {
    const { events } = collect([
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1234 } },
    ]);
    expect(events).toEqual([{ kind: 'rate_limit', resetsAt: 1234 }]);
  });

  it('maps a rejected rate_limit_event without resetsAt to a bare rate_limit', () => {
    const { events } = collect([
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } },
    ]);
    expect(events).toEqual([{ kind: 'rate_limit' }]);
  });

  it('maps a 429 api_retry with retry_delay_ms', () => {
    const { events } = collect([
      { type: 'system', subtype: 'api_retry', error_status: 429, retry_delay_ms: 500 },
    ]);
    expect(events).toEqual([{ kind: 'rate_limit', retryDelayMs: 500 }]);
  });

  it('returns a success outcome on result success', () => {
    const { outcome } = collect([
      { type: 'result', subtype: 'success', result: 'done', num_turns: 3,
        stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } },
    ]);
    expect(outcome).toEqual({
      status: 'success', output: 'done', tokensIn: 10, tokensOut: 20,
      numTurns: 3, stopReason: 'end_turn',
    });
  });

  it('returns an error outcome on result error with denials', () => {
    const { outcome } = collect([
      { type: 'result', subtype: 'error_max_turns', errors: ['boom'],
        permission_denials: [{ tool_name: 'Bash' }],
        num_turns: 5, stop_reason: null, usage: { input_tokens: 1, output_tokens: 2 } },
    ]);
    expect(outcome).toEqual({
      status: 'error', errorType: 'error_max_turns',
      output: '[error_max_turns]\nboom\nPermission denied: Bash',
      tokensIn: 1, tokensOut: 2, numTurns: 5, stopReason: null,
      permissionDenials: ['Bash'],
    });
  });

  it('returns null for non-terminal messages', () => {
    const acc = newAccumulator();
    expect(reduceMessage({ type: 'assistant', message: { content: [] } }, acc, () => {})).toBeNull();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run src/llm/anthropic/message-reducer.test.ts`
Expected: FAIL — cannot find module `./message-reducer.js`.

- [ ] **Step 6: Implement the reducer**

Create `src/llm/anthropic/message-reducer.ts`:

```typescript
import type { AgentEvent, AgentRunOutcome } from '../types.js';

export interface OutcomeAccumulator {
  tokensIn: number;
  tokensOut: number;
}

export function newAccumulator(): OutcomeAccumulator {
  return { tokensIn: 0, tokensOut: 0 };
}

/**
 * SDK 메시지 하나를 처리한다. 스트리밍 이벤트는 onEvent로 흘려보내고,
 * 'result' 메시지일 때만 최종 AgentRunOutcome을 반환한다(그 외에는 null).
 * msg는 SDK 미타입 메시지라 any로 받는다.
 */
export function reduceMessage(
  msg: any,
  _acc: OutcomeAccumulator,
  onEvent: (e: AgentEvent) => void,
): AgentRunOutcome | null {
  if (msg.type === 'assistant') {
    for (const block of (msg.message?.content ?? [])) {
      if (block.type === 'text' && block.text?.trim()) {
        onEvent({ kind: 'text', text: block.text.trim() });
      } else if (block.type === 'tool_use') {
        const input = typeof block.input === 'object'
          ? JSON.stringify(block.input)
          : String(block.input ?? '');
        onEvent({ kind: 'tool_call', name: block.name, input });
      }
    }
    return null;
  }

  if (msg.type === 'tool_result') {
    const content = Array.isArray(msg.content)
      ? msg.content.map((c: any) => c.text ?? '').join('')
      : String(msg.content ?? '');
    if (content.trim()) onEvent({ kind: 'tool_result', content });
    return null;
  }

  if (msg.type === 'rate_limit_event') {
    const info = msg.rate_limit_info;
    if (info?.status === 'rejected') {
      onEvent(info.resetsAt != null ? { kind: 'rate_limit', resetsAt: info.resetsAt } : { kind: 'rate_limit' });
    }
    return null;
  }

  if (msg.type === 'system' && msg.subtype === 'api_retry' && msg.error_status === 429) {
    onEvent(msg.retry_delay_ms != null ? { kind: 'rate_limit', retryDelayMs: msg.retry_delay_ms } : { kind: 'rate_limit' });
    return null;
  }

  if (msg.type === 'result') {
    const tokensIn = msg.usage?.input_tokens ?? 0;
    const tokensOut = msg.usage?.output_tokens ?? 0;
    const numTurns = msg.num_turns ?? 0;
    const stopReason = msg.stop_reason ?? null;

    if (msg.subtype === 'success') {
      return { status: 'success', output: msg.result ?? '', tokensIn, tokensOut, numTurns, stopReason };
    }
    const errorType = msg.subtype ?? 'error_unknown';
    const errors: string[] = Array.isArray(msg.errors) ? msg.errors : [];
    const permissionDenials: string[] = (msg.permission_denials ?? []).map((d: any) => d.tool_name ?? String(d));
    const output = [
      `[${errorType}]`,
      errors.length > 0 ? errors.join('\n') : '',
      permissionDenials.length > 0 ? `Permission denied: ${permissionDenials.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    return { status: 'error', output, tokensIn, tokensOut, numTurns, stopReason, errorType, permissionDenials };
  }

  return null;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run src/llm/anthropic/message-reducer.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/llm/types.ts src/llm/anthropic/message-reducer.ts src/llm/anthropic/message-reducer.test.ts
git commit -m "feat: add llm seam types and sdk message reducer with vitest"
```

---

### Task 2: AnthropicAgentRunner

Wraps the SDK `query()` loop, delegating per-message handling to the reducer and
handling the no-result / terminal cases. Tested by mocking the SDK to yield fake messages.

**Files:**
- Create: `src/llm/anthropic/agent-runner.ts`
- Test: `src/llm/anthropic/agent-runner.test.ts`

**Interfaces:**
- Consumes: `AgentRunner`, `AgentRunRequest`, `AgentEvent`, `AgentRunOutcome` from `../types.js`; `reduceMessage`, `newAccumulator` from `./message-reducer.js`; `query` from `@anthropic-ai/claude-agent-sdk`.
- Produces: `export const anthropicAgentRunner: AgentRunner`.

- [ ] **Step 1: Write the failing test**

Create `src/llm/anthropic/agent-runner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (...a: any[]) => queryMock(...a) }));

import { anthropicAgentRunner } from './agent-runner.js';
import type { AgentEvent } from '../types.js';

function asyncGen(msgs: any[]) {
  return (async function* () { for (const m of msgs) yield m; })();
}

const req = { prompt: 'p', cwd: '/tmp', tools: ['Read'], model: 'claude-opus-4-8', effort: 'high' };

beforeEach(() => queryMock.mockReset());

describe('anthropicAgentRunner', () => {
  it('passes tools/model/effort to query and returns the success outcome', async () => {
    queryMock.mockReturnValue(asyncGen([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'result', subtype: 'success', result: 'ok', num_turns: 1, stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 6 } },
    ]));
    const events: AgentEvent[] = [];
    const outcome = await anthropicAgentRunner.run(req, (e) => events.push(e));

    expect(queryMock).toHaveBeenCalledOnce();
    const opts = queryMock.mock.calls[0][0].options;
    expect(opts.allowedTools).toEqual(['Read']);
    expect(opts.model).toBe('claude-opus-4-8');
    expect(opts.effort).toBe('high');
    expect(events).toContainEqual({ kind: 'text', text: 'hi' });
    expect(outcome).toMatchObject({ status: 'success', output: 'ok', tokensIn: 5, tokensOut: 6 });
  });

  it('adds the Agent tool when subagents are present', async () => {
    queryMock.mockReturnValue(asyncGen([
      { type: 'result', subtype: 'success', result: '', usage: {} },
    ]));
    await anthropicAgentRunner.run({ ...req, subagents: { lens: {} } }, () => {});
    const opts = queryMock.mock.calls[0][0].options;
    expect(opts.allowedTools).toEqual(['Read', 'Agent']);
    expect(opts.agents).toEqual({ lens: {} });
  });

  it('returns a no_result error outcome when the stream ends without a result', async () => {
    queryMock.mockReturnValue(asyncGen([
      { type: 'assistant', message: { content: [] } },
    ]));
    const outcome = await anthropicAgentRunner.run(req, () => {});
    expect(outcome).toMatchObject({ status: 'error', errorType: 'no_result' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/llm/anthropic/agent-runner.test.ts`
Expected: FAIL — cannot find module `./agent-runner.js`.

- [ ] **Step 3: Implement the runner**

Create `src/llm/anthropic/agent-runner.ts`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRunner, AgentRunRequest, AgentEvent, AgentRunOutcome } from '../types.js';
import { reduceMessage, newAccumulator } from './message-reducer.js';

export const anthropicAgentRunner: AgentRunner = {
  async run(req: AgentRunRequest, onEvent: (e: AgentEvent) => void): Promise<AgentRunOutcome> {
    const hasSubagents = req.subagents && Object.keys(req.subagents).length > 0;
    const allowedTools = hasSubagents ? [...req.tools, 'Agent'] : req.tools;
    const acc = newAccumulator();

    for await (const msg of query({
      prompt: req.prompt,
      options: {
        allowedTools,
        permissionMode: 'bypassPermissions',
        cwd: req.cwd,
        model: req.model,
        ...(req.effort !== undefined ? { effort: req.effort } : {}),
        ...(hasSubagents ? { agents: req.subagents } : {}),
      },
    } as any)) {
      const outcome = reduceMessage(msg, acc, onEvent);
      if (outcome) return outcome;
    }

    return {
      status: 'error', output: '[no result] Stream ended without a result message',
      tokensIn: 0, tokensOut: 0, numTurns: 0, stopReason: null, errorType: 'no_result',
    };
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/llm/anthropic/agent-runner.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/llm/anthropic/agent-runner.ts src/llm/anthropic/agent-runner.test.ts
git commit -m "feat: add anthropic agent runner over the claude agent sdk"
```

---

### Task 3: AnthropicCompleter and AnthropicModelCatalog

Move the `complete.ts` body and the `model-config` SDK loading body behind their
interfaces. Both are thin SDK wrappers; tested with a mocked `query`.

**Files:**
- Create: `src/llm/anthropic/completer.ts`
- Create: `src/llm/anthropic/models.ts`
- Test: `src/llm/anthropic/completer.test.ts`

**Interfaces:**
- Consumes: `Completer`, `CompleteRequest`, `ModelCatalog`, `ModelSpec` from `../types.js`; `query` from the SDK.
- Produces:
  - `export const anthropicCompleter: Completer`
  - `export const anthropicModelCatalog: ModelCatalog`

- [ ] **Step 1: Write the failing completer test**

Create `src/llm/anthropic/completer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (...a: any[]) => queryMock(...a) }));

import { anthropicCompleter } from './completer.js';

function asyncGen(msgs: any[]) {
  return (async function* () { for (const m of msgs) yield m; })();
}

beforeEach(() => queryMock.mockReset());

describe('anthropicCompleter', () => {
  it('returns the result text on success', async () => {
    queryMock.mockReturnValue(asyncGen([{ type: 'result', subtype: 'success', result: 'hello' }]));
    const out = await anthropicCompleter.complete({ message: 'hi' });
    expect(out).toBe('hello');
  });

  it('appends a JSON-only instruction to the system prompt when json is set', async () => {
    queryMock.mockReturnValue(asyncGen([{ type: 'result', subtype: 'success', result: '{}' }]));
    await anthropicCompleter.complete({ system: 'base', message: 'hi', json: true });
    const opts = queryMock.mock.calls[0][0].options;
    expect(opts.systemPrompt).toContain('base');
    expect(opts.systemPrompt).toContain('JSON');
  });

  it('throws on a failed completion', async () => {
    queryMock.mockReturnValue(asyncGen([{ type: 'result', subtype: 'error_during_execution' }]));
    await expect(anthropicCompleter.complete({ message: 'hi' })).rejects.toThrow(/completion failed/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/llm/anthropic/completer.test.ts`
Expected: FAIL — cannot find module `./completer.js`.

- [ ] **Step 3: Implement the completer**

Create `src/llm/anthropic/completer.ts`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Completer, CompleteRequest } from '../types.js';

export const anthropicCompleter: Completer = {
  async complete(req: CompleteRequest): Promise<string> {
    let system = req.system ?? '';
    if (req.json) {
      system += (system ? '\n\n' : '') +
        '반드시 유효한 JSON 객체 하나만 출력하세요. 코드펜스(```)나 설명 문구 없이 JSON만 반환하세요.';
    }

    let output = '';
    for await (const msg of query({
      prompt: req.message,
      options: {
        ...(system ? { systemPrompt: system } : {}),
        allowedTools: [],
        permissionMode: 'bypassPermissions',
        ...(req.model ? { model: req.model } : {}),
      },
    } as any)) {
      const m = msg as any;
      if (m.type === 'result') {
        if (m.subtype === 'success') output = m.result ?? '';
        else throw new Error(`completion failed: ${m.subtype ?? 'unknown'}`);
      }
    }
    return output;
  },
};
```

Note: the caller (Task 6) supplies the model fallback (`req.model ?? modelConfig.getModel()`),
keeping `modelConfig` out of this provider module.

- [ ] **Step 4: Implement the model catalog**

Create `src/llm/anthropic/models.ts`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelCatalog, ModelSpec } from '../types.js';

/** SDK ModelInfo → ModelSpec. */
function mapModelInfo(m: any): ModelSpec {
  return {
    id: m.value,
    displayName: m.displayName ?? m.value,
    description: m.description,
    effortLevels: (m.supportedEffortLevels ?? []) as string[],
  };
}

export const anthropicModelCatalog: ModelCatalog = {
  async listModels(): Promise<ModelSpec[]> {
    const q = query({ prompt: 'hi', options: { allowedTools: [], permissionMode: 'bypassPermissions' } });
    let models: any[];
    try {
      models = await (q as any).supportedModels();
    } finally {
      await (q as any).interrupt().catch(() => {});
    }
    return Array.isArray(models) ? models.map(mapModelInfo) : [];
  },
};
```

- [ ] **Step 5: Run the completer test to verify it passes**

Run: `npx vitest run src/llm/anthropic/completer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/llm/anthropic/completer.ts src/llm/anthropic/models.ts src/llm/anthropic/completer.test.ts
git commit -m "feat: add anthropic completer and model catalog"
```

---

### Task 4: Provider registry

Selects the active provider implementations from `AUTO_DEV_PROVIDER` (default
`anthropic`) and fails fast on unknown values.

**Files:**
- Create: `src/llm/registry.ts`
- Test: `src/llm/registry.test.ts`

**Interfaces:**
- Consumes: `AgentRunner`, `Completer`, `ModelCatalog` from `./types.js`; `anthropicAgentRunner`, `anthropicCompleter`, `anthropicModelCatalog` from `./anthropic/*`.
- Produces: `getAgentRunner(): AgentRunner`, `getCompleter(): Completer`, `getModelCatalog(): ModelCatalog`.

- [ ] **Step 1: Write the failing test**

Create `src/llm/registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getAgentRunner, getCompleter, getModelCatalog } from './registry.js';
import { anthropicAgentRunner } from './anthropic/agent-runner.js';
import { anthropicCompleter } from './anthropic/completer.js';
import { anthropicModelCatalog } from './anthropic/models.js';

describe('registry', () => {
  it('defaults to the anthropic implementations', () => {
    expect(getAgentRunner()).toBe(anthropicAgentRunner);
    expect(getCompleter()).toBe(anthropicCompleter);
    expect(getModelCatalog()).toBe(anthropicModelCatalog);
  });

  it('fails fast on an unknown provider', () => {
    const prev = process.env.AUTO_DEV_PROVIDER;
    process.env.AUTO_DEV_PROVIDER = 'bogus';
    try {
      expect(() => getAgentRunner()).toThrow(/Unknown provider: bogus/);
    } finally {
      if (prev === undefined) delete process.env.AUTO_DEV_PROVIDER;
      else process.env.AUTO_DEV_PROVIDER = prev;
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/llm/registry.test.ts`
Expected: FAIL — cannot find module `./registry.js`.

- [ ] **Step 3: Implement the registry**

Create `src/llm/registry.ts`:

```typescript
import type { AgentRunner, Completer, ModelCatalog } from './types.js';
import { anthropicAgentRunner } from './anthropic/agent-runner.js';
import { anthropicCompleter } from './anthropic/completer.js';
import { anthropicModelCatalog } from './anthropic/models.js';

interface Provider {
  agentRunner: AgentRunner;
  completer: Completer;
  modelCatalog: ModelCatalog;
}

const PROVIDERS: Record<string, Provider> = {
  anthropic: {
    agentRunner: anthropicAgentRunner,
    completer: anthropicCompleter,
    modelCatalog: anthropicModelCatalog,
  },
};

function active(): Provider {
  const name = process.env.AUTO_DEV_PROVIDER ?? 'anthropic';
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  return provider;
}

export function getAgentRunner(): AgentRunner { return active().agentRunner; }
export function getCompleter(): Completer { return active().completer; }
export function getModelCatalog(): ModelCatalog { return active().modelCatalog; }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/llm/registry.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/llm/registry.ts src/llm/registry.test.ts
git commit -m "feat: add llm provider registry with fail-fast selection"
```

---

### Task 5: Rewire runner.ts to the AgentRunner seam

Replace the inline `query()` loop in `_execute` with a call to `getAgentRunner().run()`,
mapping normalized `AgentEvent`s to the existing `emitRunEvent` / `circuitBreaker` calls.
All DB / cost-guard / logging orchestration stays in `runner.ts`.

**Files:**
- Modify: `src/lib/runner.ts` (replace the `query` import + the `query()` loop in `_execute`, lines ~1, ~40-145)

**Interfaces:**
- Consumes: `getAgentRunner` from `../llm/registry.js`; `AgentEvent` from `../llm/types.js`.
- Produces: no signature changes — `runAgent`, `runAgentBackground`, `RunOptions`, `RunResult` unchanged.

- [ ] **Step 1: Replace the SDK import**

In `src/lib/runner.ts`, change line 1 from:

```typescript
import { query, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
```

to:

```typescript
import { type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { getAgentRunner } from '../llm/registry.js';
import type { AgentEvent } from '../llm/types.js';
```

- [ ] **Step 2: Replace the query loop in `_execute`**

In `src/lib/runner.ts`, replace the entire body of the `try {` block in `_execute`
(from the `const tools = ...` line through the end of the `for await (...)` loop and
the "stream ended without result" fallback, i.e. the current lines ~41-154) with:

```typescript
    // 기본값은 읽기 전용. 구현 권한(Write/Bash)은 호출부가 명시적으로 부여해야 한다
    // (역할 경계는 src/agents/specs.ts 의 AGENT_SPECS 가 단일 출처).
    const tools = opts.tools ?? ['Read'];
    const now = () => new Date().toISOString();

    const onEvent = (e: AgentEvent) => {
      if (e.kind === 'text') {
        emitRunEvent(runId, { type: 'text', ts: now(), data: e.text.slice(0, 500) });
      } else if (e.kind === 'tool_call') {
        emitRunEvent(runId, { type: 'tool_call', ts: now(), data: `${e.name}(${e.input.slice(0, 200)})` });
      } else if (e.kind === 'tool_result') {
        emitRunEvent(runId, { type: 'tool_result', ts: now(), data: e.content.slice(0, 200) });
      } else if (e.kind === 'rate_limit') {
        if (e.resetsAt != null) {
          circuitBreaker.openUntil(e.resetsAt);
          log.warn({ ...ctx, resetsAt: e.resetsAt }, 'Rate limit — circuit opened');
        } else if (e.retryDelayMs != null) {
          circuitBreaker.openUntil(Date.now() + e.retryDelayMs);
          log.warn({ ...ctx, retryDelayMs: e.retryDelayMs }, '429 retry — circuit opened');
        } else {
          circuitBreaker.openForFallback();
          log.warn(ctx, 'Rate limit (no reset) — circuit opened with fallback');
        }
      }
    };

    const outcome = await getAgentRunner().run(
      { prompt: opts.prompt, cwd, tools, subagents: opts.subagents, model: modelConfig.getModel(), effort: modelConfig.getEffortOption() },
      onEvent,
    );

    const durationMs = Date.now() - start;
    if (outcome.status === 'success') {
      output = outcome.output;
      tokensIn = outcome.tokensIn;
      tokensOut = outcome.tokensOut;
      costGuard.recordRun();
      updateRun(runId, { output, tokensIn, tokensOut, status: 'DONE', durationMs, stopReason: outcome.stopReason ?? undefined, numTurns: outcome.numTurns });
      log.info({ ...ctx, tokensIn, tokensOut, durationMs, numTurns: outcome.numTurns, stopReason: outcome.stopReason }, 'Agent done');
      emitRunEvent(runId, { type: 'status', ts: now(), data: 'DONE' });
      closeEmitter(runId);
      return { runId, output, tokensIn, tokensOut, durationMs };
    } else {
      output = outcome.output;
      tokensIn = outcome.tokensIn;
      tokensOut = outcome.tokensOut;
      updateRun(runId, { output, tokensIn, tokensOut, status: 'FAILED', durationMs, errorType: outcome.errorType, stopReason: outcome.stopReason ?? undefined, numTurns: outcome.numTurns });
      log.error({ ...ctx, errorType: outcome.errorType, permDenials: outcome.permissionDenials, numTurns: outcome.numTurns, stopReason: outcome.stopReason, durationMs }, 'Agent result error');
      emitRunEvent(runId, { type: 'status', ts: now(), data: `FAILED:${outcome.errorType}` });
      closeEmitter(runId);
      return { runId, output, tokensIn, tokensOut, durationMs };
    }
```

Leave the existing `catch (err) { ... }` block (exception → FAILED + rethrow) unchanged.
The now-unused `hasSubagents`/`allTools` locals are removed by this replacement; verify no
other references remain.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If `tokensIn`/`tokensOut`/`output` were declared with `let` at the
top of `_execute` and are now only assigned in branches, that is fine; if the compiler flags
them as unused before assignment, keep the existing `let output = ''; let tokensIn = 0; let tokensOut = 0;` declarations.)

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (all prior tests still green; nothing imports a broken module).

- [ ] **Step 5: Manual smoke test**

Run a single read-only agent through the real CLI to confirm end-to-end behavior
(events stream, run recorded):

```bash
AUTO_DEV_DB_PATH=/tmp/smoke.db npx tsx src/cli.ts review "src/lib/runner.ts 의 변경이 합리적인지 한 줄로 평가" || true
npx tsx src/cli.ts status | head -20
```

Expected: the run completes (DONE or a normal FAILED), and `status` lists the run. No crash,
no `query is not a function` style error.

- [ ] **Step 6: Commit**

```bash
git add src/lib/runner.ts
git commit -m "refactor: route runner through the llm agent-runner seam"
```

---

### Task 6: Rewire complete.ts and model-config.ts to the seam

Delegate the two remaining `query()` call sites to `getCompleter()` and `getModelCatalog()`.
`modelConfig` keeps all selection-state logic (fallback list, reconcile, effort validation).

**Files:**
- Modify: `src/lib/complete.ts` (replace the `query`-based body of `complete`, keep `parseJsonLoose`)
- Modify: `src/lib/model-config.ts` (replace the `query().supportedModels()` body inside `loadModelsFromCli`)

**Interfaces:**
- Consumes: `getCompleter` from `../llm/registry.js`; `getModelCatalog` from `../llm/registry.js`.
- Produces: no signature changes — `complete`, `parseJsonLoose`, `modelConfig`, `loadModelsFromCli` unchanged.

- [ ] **Step 1: Rewrite complete.ts**

Replace the full contents of `src/lib/complete.ts` with:

```typescript
import { getCompleter } from '../llm/registry.js';
import { modelConfig } from './model-config.js';

export interface CompleteOptions {
  system?: string;
  message: string;
  json?: boolean;
  model?: string;
}

/**
 * 활성 프로바이더로 단발성 텍스트를 생성합니다. 도구 없이 한 턴만 돌립니다.
 * 모델 미지정 시 modelConfig의 현재 선택을 사용합니다.
 */
export async function complete(opts: CompleteOptions): Promise<string> {
  return getCompleter().complete({
    system: opts.system,
    message: opts.message,
    json: opts.json,
    model: opts.model ?? modelConfig.getModel(),
  });
}

/** 모델이 코드펜스나 설명을 섞어도 첫 JSON 객체를 추출해 파싱합니다. */
export function parseJsonLoose(text: string): any {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}
```

- [ ] **Step 2: Rewire model-config.ts loading**

In `src/lib/model-config.ts`:

Change the import line 1 from:

```typescript
import { query, type EffortLevel } from '@anthropic-ai/claude-agent-sdk';
```

to:

```typescript
import { type EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { getModelCatalog } from '../llm/registry.js';
```

Delete the now-unused `mapModelInfo` function (lines ~26-34; the mapping now lives in
`src/llm/anthropic/models.ts`).

Replace the body of `loadModelsFromCli` (the `try { ... } catch { ... }`) with:

```typescript
export async function loadModelsFromCli(): Promise<void> {
  try {
    const models = await getModelCatalog().listModels();
    if (models.length > 0) {
      availableModels = models;
      reconcileSelection();
      loadedFromCli = true;
      log.info({ count: availableModels.length, models: availableModels.map(m => m.id) }, 'Loaded models from provider');
    } else {
      log.warn({}, 'Provider returned no models — keeping fallback list');
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to load models from provider — keeping fallback list');
  }
}
```

Note: `ModelSpec` in `model-config.ts` already matches `effortLevels: EffortLevel[]`, and the
catalog returns `effortLevels: string[]`. Assigning `availableModels = models` may need a cast
`availableModels = models as ModelSpec[];` — apply that cast if `tsc` complains, since
`EffortLevel` is a string literal union.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (apply the `as ModelSpec[]` cast from Step 2 if needed).

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (all tests).

- [ ] **Step 5: Manual smoke test**

```bash
npx tsx src/cli.ts status | head -5
```

Then confirm the clarifier path (which uses `complete`) still works by submitting a tiny
spec through the dashboard or the spec workflow, or at minimum confirm the server boots and
loads models:

```bash
AUTO_DEV_DB_PATH=/tmp/smoke2.db timeout 15 npx tsx src/cli.ts serve 2>&1 | grep -m1 -E "listening|Loaded models" || true
```

Expected: log shows "listening" and "Loaded models from provider" (or the fallback warning if
offline) — no import/`query` crash.

- [ ] **Step 6: Commit**

```bash
git add src/lib/complete.ts src/lib/model-config.ts
git commit -m "refactor: route complete and model discovery through the llm seam"
```

---

## Self-Review

**Spec coverage:**
- Two seam interfaces (`AgentRunner`, `Completer`) + `ModelCatalog` → Task 1 (types).
- `src/llm/anthropic/*` implementations → Tasks 2 (agent-runner), 3 (completer, models).
- `registry.ts` with `AUTO_DEV_PROVIDER` + fail-fast → Task 4.
- Event normalization (`AgentEvent`) + reducer → Task 1; consumed by runner → Task 5.
- `runner.ts` keeps DB/circuit-breaker/cost-guard/SSE orchestration → Task 5.
- `complete.ts` delegates, keeps `parseJsonLoose` → Task 6.
- `model-config.ts` keeps fallback/reconcile/effort, delegates discovery → Task 6.
- Error handling (no_result/exception/error subtypes) → reducer + runner Tasks 1/2/5; completer throw → Task 3.
- Testing with fakes → reducer unit tests (Task 1), mocked-SDK tests (Tasks 2/3), registry test (Task 4); orchestration preserved verified by typecheck + manual smoke (Tasks 5/6).
- Behavior-preservation / new env default → Global Constraints + Tasks 5/6 smoke steps.

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output.

**Type consistency:** `AgentRunRequest`/`AgentEvent`/`AgentRunOutcome` (Task 1) are consumed verbatim in Tasks 2 and 5. `getAgentRunner`/`getCompleter`/`getModelCatalog` (Task 4) are consumed in Tasks 5/6. `anthropicAgentRunner`/`anthropicCompleter`/`anthropicModelCatalog` names are consistent across Tasks 2/3/4. `reduceMessage`/`newAccumulator`/`OutcomeAccumulator` consistent between Tasks 1 and 2.
