import { query, type EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { log } from './logger.js';

export interface ModelSpec {
  id: string;
  displayName: string;
  description?: string;
  effortLevels: EffortLevel[];
}

/** CLI 조회 실패 시 사용하는 폴백 목록 (전체 모델 ID 기준 — SDK가 별칭/풀네임 모두 허용). */
const FALLBACK_MODELS: ModelSpec[] = [
  { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', effortLevels: ['low', 'medium', 'high', 'max'] },
  { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', effortLevels: ['low', 'medium', 'high'] },
];

const DEFAULT_EFFORT = (process.env.AUTO_DEV_EFFORT ?? 'high') as EffortLevel;
const DESIRED_MODEL = process.env.AUTO_DEV_MODEL;

let availableModels: ModelSpec[] = FALLBACK_MODELS;
let currentModel = DESIRED_MODEL ?? FALLBACK_MODELS[0].id;
let currentEffort: EffortLevel = DEFAULT_EFFORT;
let loadedFromCli = false;

/** SDK ModelInfo → 내부 ModelSpec 변환. */
function mapModelInfo(m: any): ModelSpec {
  return {
    id: m.value,
    displayName: m.displayName ?? m.value,
    description: m.description,
    effortLevels: (m.supportedEffortLevels ?? []) as EffortLevel[],
  };
}

/** 현재 선택값이 목록과 모순되지 않도록 보정한다. */
function reconcileSelection(): void {
  if (!availableModels.find(m => m.id === currentModel)) {
    const preferred = availableModels.find(m => m.id === 'default') ?? availableModels[0];
    if (preferred) currentModel = preferred.id;
  }
  const spec = availableModels.find(m => m.id === currentModel);
  if (spec && spec.effortLevels.length > 0 && !spec.effortLevels.includes(currentEffort)) {
    currentEffort = spec.effortLevels.includes('high')
      ? 'high'
      : spec.effortLevels[spec.effortLevels.length - 1];
  }
}

/**
 * Claude CLI(구독)에서 사용 가능한 모델 목록을 동적으로 가져와 캐시한다.
 * 실패하면 폴백 목록을 유지한다.
 */
export async function loadModelsFromCli(): Promise<void> {
  try {
    const q = query({ prompt: 'hi', options: { allowedTools: [], permissionMode: 'bypassPermissions' } });
    let models: any[];
    try {
      models = await q.supportedModels();
    } finally {
      await q.interrupt().catch(() => {});
    }

    if (Array.isArray(models) && models.length > 0) {
      availableModels = models.map(mapModelInfo);
      reconcileSelection();
      loadedFromCli = true;
      log.info({ count: availableModels.length, models: availableModels.map(m => m.id) }, 'Loaded models from CLI');
    } else {
      log.warn({}, 'CLI returned no models — keeping fallback list');
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to load models from CLI — keeping fallback list');
  }
}

export const modelConfig = {
  getModel(): string { return currentModel; },
  getEffort(): EffortLevel { return currentEffort; },

  /** query 옵션으로 넘길 effort. 현재 모델이 effort를 지원하지 않으면 undefined. */
  getEffortOption(): EffortLevel | undefined {
    const spec = availableModels.find(m => m.id === currentModel);
    return spec && spec.effortLevels.length === 0 ? undefined : currentEffort;
  },

  isLoadedFromCli(): boolean { return loadedFromCli; },

  set(model: string, effort: EffortLevel): void {
    const spec = availableModels.find(m => m.id === model);
    if (!spec) throw new Error(`Unknown model: ${model}`);
    // 모델이 effort 레벨을 선언한 경우에만 검증한다.
    if (spec.effortLevels.length > 0 && !spec.effortLevels.includes(effort)) {
      throw new Error(`Model ${model} does not support effort level: ${effort}`);
    }
    currentModel = model;
    currentEffort = effort;
  },

  stats(): { model: string; effort: EffortLevel; availableModels: ModelSpec[]; loadedFromCli: boolean } {
    return { model: currentModel, effort: currentEffort, availableModels, loadedFromCli };
  },
};
