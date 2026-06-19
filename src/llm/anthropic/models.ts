import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelCatalog, ModelSpec } from '../types.js';

/** SDK ModelInfo → ModelSpec. */
function mapModelInfo(m: any): ModelSpec {
  return {
    id: m.value,
    displayName: m.displayName ?? m.value,
    description: m.description,
    effortLevels: (m.supportedEffortLevels ?? []) as string[],
  };
}

export const anthropicModelCatalog: ModelCatalog = {
  async listModels(): Promise<ModelSpec[]> {
    const q = query({ prompt: 'hi', options: { allowedTools: [], permissionMode: 'bypassPermissions' } });
    let models: any[];
    try {
      models = await (q as any).supportedModels();
    } finally {
      await (q as any).interrupt().catch(() => {});
    }
    return Array.isArray(models) ? models.map(mapModelInfo) : [];
  },
};
