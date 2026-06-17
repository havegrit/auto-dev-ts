import type { RunResult } from '../lib/runner.js';
import { runNamedAgent, type AgentRunOpts } from './dispatch.js';

export function clarifier(input: string, opts: AgentRunOpts = {}): Promise<RunResult> {
  return runNamedAgent('clarifier', input, opts);
}
