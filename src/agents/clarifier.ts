import { runAgent, type RunResult } from '../lib/runner.js';
import { loadPrompt } from '../lib/prompt.js';

const SYSTEM = loadPrompt('clarifier.system.md');

export async function clarifier(input: string, opts: { workflowRunId?: string; triggerSource?: string; triggerDetail?: string; cwd?: string } = {}): Promise<RunResult> {
  return runAgent({ name: 'clarifier', prompt: `${SYSTEM}\n\n---\n\n${input}`, tools: ['Read'], ...opts });
}
