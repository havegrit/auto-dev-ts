import type { RunResult } from '../lib/runner.js';
import { runNamedAgent, type AgentRunOpts } from './dispatch.js';

export function cicd(input: string, opts: AgentRunOpts = {}): Promise<RunResult> {
  return runNamedAgent('cicd', input, opts);
}
