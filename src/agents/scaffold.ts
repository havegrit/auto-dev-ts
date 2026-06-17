import type { RunResult } from '../lib/runner.js';
import { runNamedAgent, type AgentRunOpts } from './dispatch.js';

export function scaffold(input: string, opts: AgentRunOpts = {}): Promise<RunResult> {
  return runNamedAgent('scaffold', input, opts);
}
