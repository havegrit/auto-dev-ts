import type { AgentRunner, Completer, ModelCatalog, ModelSpec } from './types.js';
import { anthropicAgentRunner } from './anthropic/agent-runner.js';
import { anthropicCompleter } from './anthropic/completer.js';
import { anthropicModelCatalog } from './anthropic/models.js';
import { codexAgentRunner } from './codex/agent-runner.js';
import { codexCompleter } from './codex/completer.js';
import { codexModelCatalog } from './codex/models.js';
import { openaiAgentRunner } from './openai/agent-runner.js';
import { openaiCompleter } from './openai/completer.js';
import { openaiModelCatalog } from './openai/models.js';

interface Provider {
  agentRunner: AgentRunner;
  completer: Completer;
  modelCatalog: ModelCatalog;
}

export interface ProviderModelCatalogResult {
  models: ModelSpec[];
  authoritative: boolean;
  error?: string;
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
  'openai-compatible': {
    agentRunner: openaiAgentRunner,
    completer: openaiCompleter,
    modelCatalog: openaiModelCatalog,
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

/** 각 provider 결과를 따로 보존해 일부 provider의 일시 장애가 다른 목록을 덮지 않게 한다. */
export async function getProviderModelCatalogs(): Promise<Record<string, ProviderModelCatalogResult>> {
  const results = await Promise.all(Object.entries(PROVIDERS).map(async ([providerName, provider]) => {
    try {
      const result = provider.modelCatalog.listModelsWithStatus
        ? await provider.modelCatalog.listModelsWithStatus()
        : { models: await provider.modelCatalog.listModels(), authoritative: true };
      return [providerName, {
        models: result.models.map(model => qualifiedModel(providerName, model)),
        authoritative: result.authoritative,
      }] as const;
    } catch (err) {
      return [providerName, {
        models: [],
        authoritative: false,
        error: err instanceof Error ? err.message : String(err),
      }] as const;
    }
  }));
  return Object.fromEntries(results);
}

export function getModelCatalog(): ModelCatalog {
  return {
    async listModels(): Promise<ModelSpec[]> {
      const catalogs = await getProviderModelCatalogs();
      return Object.values(catalogs).flatMap(catalog => catalog.models);
    },
  };
}
