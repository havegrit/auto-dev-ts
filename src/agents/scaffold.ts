import { runAgent, type RunResult } from '../lib/runner.js';
import { loadPrompt } from '../lib/prompt.js';

const SYSTEM = loadPrompt('scaffold.system.md');

export async function scaffold(input: string, opts: { workflowRunId?: string; triggerSource?: string; triggerDetail?: string; cwd?: string } = {}): Promise<RunResult> {
  return runAgent({ name: 'scaffold', prompt: `${SYSTEM}\n\n---\n\n${input}`, tools: ['Read', 'Write', 'Bash'], ...opts });
}
