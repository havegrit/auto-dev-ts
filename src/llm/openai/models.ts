import type { ModelCatalog, ModelSpec } from '../types.js';

/**
 * env(AUTO_DEV_OPENAI_MODELS)에 명시된 모델만 나열한다. 라이브 /v1/models 조회는
 * 하지 않는다(시작 지연·방대한 목록 방지). API 키가 없으면 프로바이더 미설정으로 보고
 * 빈 목록을 반환한다(registry가 이를 조용히 건너뛴다).
 */
function configuredModels(): string[] {
  if (!process.env.AUTO_DEV_OPENAI_API_KEY) return [];
  return (process.env.AUTO_DEV_OPENAI_MODELS ?? '')
    .split(',')
    .map(m => m.trim())
    .filter(Boolean);
}

export const openaiModelCatalog: ModelCatalog = {
  async listModels(): Promise<ModelSpec[]> {
    return configuredModels().map(model => ({
      id: model,
      displayName: model,
      description: 'OpenAI-compatible configured model',
      effortLevels: [],
    } satisfies ModelSpec));
  },
};
