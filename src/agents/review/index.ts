import { runAgent, type RunResult } from '../../lib/runner.js';
import { loadPrompt } from '../../lib/prompt.js';
import { LENSES } from './lenses.js';

const SYSTEM = loadPrompt('review.system.md');

export async function review(input: string, opts: { workflowRunId?: string; triggerSource?: string; triggerDetail?: string; cwd?: string } = {}): Promise<RunResult> {
  return runAgent({ name: 'review', prompt: `${SYSTEM}\n\n---\n\n${input}`, tools: ['Read'], subagents: LENSES, ...opts });
}
