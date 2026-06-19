import type { AgentRunner, Completer, ModelCatalog } from './types.js';
import { anthropicAgentRunner } from './anthropic/agent-runner.js';
import { anthropicCompleter } from './anthropic/completer.js';
import { anthropicModelCatalog } from './anthropic/models.js';

interface Provider {
  agentRunner: AgentRunner;
  completer: Completer;
  modelCatalog: ModelCatalog;
}

const PROVIDERS: Record<string, Provider> = {
  anthropic: {
    agentRunner: anthropicAgentRunner,
    completer: anthropicCompleter,
    modelCatalog: anthropicModelCatalog,
  },
};

function active(): Provider {
  const name = process.env.AUTO_DEV_PROVIDER ?? 'anthropic';
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  return provider;
}

export function getAgentRunner(): AgentRunner { return active().agentRunner; }
export function getCompleter(): Completer { return active().completer; }
export function getModelCatalog(): ModelCatalog { return active().modelCatalog; }
