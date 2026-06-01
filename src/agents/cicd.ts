import { runAgent, type RunResult } from '../lib/runner.js';
import { loadPrompt } from '../lib/prompt.js';

const SYSTEM = loadPrompt('cicd.system.md');

export async function cicd(input: string, opts: { workflowRunId?: string; triggerSource?: string; triggerDetail?: string } = {}): Promise<RunResult> {
  return runAgent({ name: 'cicd', prompt: `${SYSTEM}\n\n---\n\n${input}`, tools: ['Read', 'Write'], ...opts });
}
