import type { AgentRunner, Completer, ModelCatalog, ModelSpec } from './types.js';
import { anthropicAgentRunner } from './anthropic/agent-runner.js';
import { anthropicCompleter } from './anthropic/completer.js';
import { anthropicModelCatalog } from './anthropic/models.js';
import { codexAgentRunner } from './codex/agent-runner.js';
import { codexCompleter } from './codex/completer.js';
import { codexModelCatalog } from './codex/models.js';

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
  'codex-cli': {
    agentRunner: codexAgentRunner,
    completer: codexCompleter,
    modelCatalog: codexModelCatalog,
  },
};

function providerNameFromModel(model?: string): string {
  if (model?.includes(':')) return model.split(':', 1)[0];
  return process.env.AUTO_DEV_PROVIDER ?? 'anthropic';
}

function qualifiedModel(providerName: string, model: ModelSpec): ModelSpec {
  const providerModel = model.providerModel ?? model.id;
  return {
    ...model,
    id: `${providerName}:${providerModel}`,
    provider: providerName,
    providerModel,
    displayName: `${providerName} / ${model.displayName}`,
  };
}

function active(model?: string): Provider {
  const name = providerNameFromModel(model);
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  return provider;
}

export function getAgentRunner(model?: string): AgentRunner { return active(model).agentRunner; }
export function getCompleter(model?: string): Completer { return active(model).completer; }
export function getModelCatalog(): ModelCatalog {
  return {
    async listModels(): Promise<ModelSpec[]> {
      const models: ModelSpec[] = [];
      for (const [providerName, provider] of Object.entries(PROVIDERS)) {
        try {
          models.push(...(await provider.modelCatalog.listModels()).map(model => qualifiedModel(providerName, model)));
        } catch {
          // A missing CLI/login for one provider should not hide models from the other provider.
        }
      }
      return models;
    },
  };
}
