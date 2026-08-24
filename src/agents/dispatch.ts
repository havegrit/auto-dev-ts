import { runAgent, runAgentBackground, type RunResult } from '../lib/runner.js';
import { loadPrompt } from '../lib/prompt.js';
import { AGENT_SPECS } from './specs.js';

const OUTPUT_STYLE_RULE = [
  '출력은 한글로 짧게 작성한다. 불필요한 설명과 내부 사고 과정은 출력하지 않는다.',
].join('\n');

export type AgentRunOpts = {
  triggerSource?: string;
  triggerDetail?: string;
  workflowRunId?: string;
  specSessionId?: string;
  cwd?: string;
  deliveryIntent?: 'ci' | 'cd';
  signal?: AbortSignal;
};

export function decorateCicdInput(input: string, deliveryIntent: 'ci' | 'cd' = 'ci'): string {
  if (/^\s*## 실행 의도\s*$/m.test(input) || input.includes('deliveryIntent: ci') || input.includes('deliveryIntent: cd')) {
    return input;
  }
  return `## 실행 의도\n- deliveryIntent: ${deliveryIntent}\n- ci: build/test/verify artifacts only\n- cd: deployment/release artifacts only when explicitly requested\n\n${input}`;
}

/**
 * 에이전트 이름으로 실행 옵션을 조립한다. 시스템 프롬프트와 도구 권한(tools)을
 * AGENT_SPECS 한곳에서만 끌어오므로, 모든 진입점(워크플로우·대시보드 API·CLI)이
 * 동일한 역할 경계를 강제받는다.
 */
function buildOptions(name: string, input: string, opts: AgentRunOpts) {
  const spec = AGENT_SPECS[name];
  if (!spec) return undefined;
  const system = loadPrompt(spec.promptFile);
  const deliveryIntent = opts.deliveryIntent ?? 'ci';
  const decoratedInput = name === 'cicd' ? decorateCicdInput(input, deliveryIntent) : input;
  return {
    name,
    prompt: `${OUTPUT_STYLE_RULE}\n\n${system}\n\n---\n\n${decoratedInput}`,
    tools: spec.tools,
    subagents: spec.subagents,
    ...opts,
  };
}

export function runNamedAgent(name: string, input: string, opts: AgentRunOpts = {}): Promise<RunResult> {
  const options = buildOptions(name, input, opts);
  if (!options) throw new Error(`Unknown agent: ${name}`);
  return runAgent(options);
}

/** 백그라운드 실행. 알 수 없는 에이전트면 undefined 반환. */
export function runNamedAgentBackground(name: string, input: string, opts: AgentRunOpts = {}): string | undefined {
  const options = buildOptions(name, input, opts);
  return options ? runAgentBackground(options) : undefined;
}
