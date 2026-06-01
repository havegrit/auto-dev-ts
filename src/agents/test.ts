import { runAgent, type RunResult } from '../lib/runner.js';
import { loadPrompt } from '../lib/prompt.js';

const SYSTEM = loadPrompt('test.system.md');

export async function test(input: string, opts: { workflowRunId?: string; triggerSource?: string; triggerDetail?: string } = {}): Promise<RunResult> {
  return runAgent({ name: 'test', prompt: `${SYSTEM}\n\n---\n\n${input}`, tools: ['Read', 'Write', 'Bash'], ...opts });
}
