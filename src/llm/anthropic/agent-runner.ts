import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRunner, AgentRunRequest, AgentEvent, AgentRunOutcome } from '../types.js';
import { reduceMessage, newAccumulator } from './message-reducer.js';
import { createStderrCollector, withStderr } from './cli-stderr.js';

export const anthropicAgentRunner: AgentRunner = {
  async run(req: AgentRunRequest, onEvent: (e: AgentEvent) => void): Promise<AgentRunOutcome> {
    const hasSubagents = req.subagents && Object.keys(req.subagents).length > 0;
    const allowedTools = hasSubagents ? [...req.tools, 'Agent'] : req.tools;
    const acc = newAccumulator();
    const cli = createStderrCollector();

    try {
      for await (const msg of query({
        prompt: req.prompt,
        options: {
          allowedTools,
          permissionMode: 'bypassPermissions',
          stderr: cli.onStderr,
          cwd: req.cwd,
          model: req.model,
          ...(req.effort !== undefined ? { effort: req.effort } : {}),
          ...(hasSubagents ? { agents: req.subagents } : {}),
        },
      } as any)) {
        const outcome = reduceMessage(msg, acc, onEvent);
        if (outcome) return outcome;
      }
    } catch (err) {
      throw withStderr(err, cli.text());
    }

    return {
      status: 'error', output: '[no result] Stream ended without a result message',
      tokensIn: 0, tokensOut: 0, numTurns: 0, stopReason: null, errorType: 'no_result',
    };
  },
};
