import type { RunResult } from '../../lib/runner.js';
import { runNamedAgent, type AgentRunOpts } from '../dispatch.js';

export function review(input: string, opts: AgentRunOpts = {}): Promise<RunResult> {
  return runNamedAgent('review', input, opts);
}
