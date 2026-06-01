import { runAgent, type RunResult } from '../lib/runner.js';
import { loadPrompt } from '../lib/prompt.js';

const SYSTEM = loadPrompt('planner.system.md');

export async function planner(input: string, opts: { workflowRunId?: string; triggerSource?: string; triggerDetail?: string } = {}): Promise<RunResult> {
  return runAgent({ name: 'planner', prompt: `${SYSTEM}\n\n---\n\n${input}`, tools: ['Read'], ...opts });
}
