import type { RunResult } from '../lib/runner.js';
import { runNamedAgent, type AgentRunOpts } from './dispatch.js';

export function test(input: string, opts: AgentRunOpts = {}): Promise<RunResult> {
  return runNamedAgent('test', input, opts);
}
