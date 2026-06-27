import type { ModelCatalog, ModelSpec } from '../types.js';
import { appConfig } from '../../lib/app-config.js';

const DEFAULT_CODEX_MODELS: ModelSpec[] = [
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    description: 'Recommended for complex coding and agentic work',
    effortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 mini',
    description: 'Faster, lower-cost option for lighter coding tasks and subagents',
    effortLevels: ['none', 'low', 'medium', 'high'],
  },
  {
    id: 'gpt-5.4-nano',
    displayName: 'GPT-5.4 nano',
    description: 'Low-cost option for simple high-volume tasks',
    effortLevels: ['none', 'low', 'medium'],
  },
];

function configuredModels(): string[] {
  const config = appConfig.get();
  const ids = [
    config.model ?? process.env.AUTO_DEV_MODEL,
    config.fallbackModel ?? process.env.AUTO_DEV_FALLBACK_MODEL,
    ...Object.values(config.agentModels ?? {}),
    ...Object.entries(process.env)
      .filter(([key, value]) => key.startsWith('AUTO_DEV_AGENT_') && key.endsWith('_MODEL') && value)
      .map(([, value]) => value as string),
  ];
  return [...new Set(ids
    .filter((id): id is string => Boolean(id))
    .map(id => id.includes(':') ? id.slice(id.indexOf(':') + 1) : id)
    .filter(id => !id.startsWith('claude-') && !['default', 'opus', 'haiku'].includes(id)))];
}

export const codexModelCatalog: ModelCatalog = {
  async listModels(): Promise<ModelSpec[]> {
    const configured = configuredModels().map(model => ({
      id: model,
      displayName: model.toUpperCase(),
      description: 'Codex CLI configured model',
      effortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    }));
    const merged = new Map<string, ModelSpec>();
    for (const model of [...DEFAULT_CODEX_MODELS, ...configured]) merged.set(model.id, model);
    return [...merged.values()];
  },
};
