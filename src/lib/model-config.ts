import { getModelCatalog } from '../llm/registry.js';
import { appConfig, type RuntimeConfig } from './app-config.js';
import { log } from './logger.js';

export interface ModelSpec {
  id: string;
  provider?: string;
  providerModel?: string;
  displayName: string;
  description?: string;
  effortLevels: string[];
}

/** CLI 조회 실패 시 사용하는 폴백 목록 (전체 모델 ID 기준 — SDK가 별칭/풀네임 모두 허용). */
const FALLBACK_MODELS: ModelSpec[] = [
  { id: 'anthropic:claude-opus-4-8', provider: 'anthropic', providerModel: 'claude-opus-4-8', displayName: 'anthropic / Claude Opus 4.8', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'anthropic:claude-sonnet-4-6', provider: 'anthropic', providerModel: 'claude-sonnet-4-6', displayName: 'anthropic / Claude Sonnet 4.6', effortLevels: ['low', 'medium', 'high', 'max'] },
  { id: 'anthropic:claude-haiku-4-5-20251001', provider: 'anthropic', providerModel: 'claude-haiku-4-5-20251001', displayName: 'anthropic / Claude Haiku 4.5', effortLevels: ['low', 'medium', 'high'] },
  { id: 'codex-cli:gpt-5.5', provider: 'codex-cli', providerModel: 'gpt-5.5', displayName: 'codex-cli / GPT-5.5', effortLevels: ['none', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'codex-cli:gpt-5.4-mini', provider: 'codex-cli', providerModel: 'gpt-5.4-mini', displayName: 'codex-cli / GPT-5.4 mini', effortLevels: ['none', 'low', 'medium', 'high'] },
];

const storedConfig = appConfig.get();
const DEFAULT_EFFORT = storedConfig.effort ?? process.env.AUTO_DEV_EFFORT ?? 'high';
const DESIRED_MODEL = storedConfig.model ?? process.env.AUTO_DEV_MODEL;

let availableModels: ModelSpec[] = FALLBACK_MODELS;
let currentModel = DESIRED_MODEL ?? FALLBACK_MODELS[0].id;
let currentEffort = DEFAULT_EFFORT;
let fallbackModel = storedConfig.fallbackModel ?? process.env.AUTO_DEV_FALLBACK_MODEL;
let agentModels: Record<string, string> = storedConfig.agentModels ?? {};
let loadedFromCli = false;

/** 현재 선택값이 목록과 모순되지 않도록 보정한다. */
function reconcileSelection(): void {
  if (!availableModels.find(m => m.id === currentModel)) {
    const preferred = availableModels.find(m => m.id === fallbackModel) ?? availableModels.find(m => m.id === 'default') ?? availableModels[0];
    if (preferred) currentModel = preferred.id;
  }
  const spec = availableModels.find(m => m.id === currentModel);
  if (spec && spec.effortLevels.length > 0 && !spec.effortLevels.includes(currentEffort)) {
    currentEffort = spec.effortLevels.includes('high')
      ? 'high'
      : spec.effortLevels[spec.effortLevels.length - 1];
  }
}

function envKeyForAgent(agentName: string): string {
  return `AUTO_DEV_AGENT_${agentName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MODEL`;
}

function firstRunnableModel(): ModelSpec | undefined {
  return availableModels[0] ?? FALLBACK_MODELS[0];
}

function availableModel(id: string | undefined): ModelSpec | undefined {
  return id ? availableModels.find(m => m.id === id) : undefined;
}

function resolveModelSpec(agentName?: string): ModelSpec {
  const agentModel = agentName ? agentModels[agentName] ?? process.env[envKeyForAgent(agentName)] : undefined;
  const candidates = agentModel !== undefined
    ? [agentModel, fallbackModel, currentModel]
    : [currentModel, fallbackModel];
  for (const id of candidates) {
    const spec = availableModel(id);
    if (spec) return spec;
  }
  const runnable = firstRunnableModel();
  if (!runnable) throw new Error('No runnable model is available');
  return runnable;
}

function resolveModelSpecById(modelId: string): ModelSpec {
  return availableModels.find(m => m.id === modelId) ?? FALLBACK_MODELS.find(m => m.id === modelId) ?? {
    id: modelId,
    provider: modelId.includes(':') ? modelId.split(':', 1)[0] : undefined,
    providerModel: modelId.includes(':') ? modelId.slice(modelId.indexOf(':') + 1) : modelId,
    displayName: modelId,
    effortLevels: [],
  };
}

function rawModelId(spec: ModelSpec): string {
  return spec.providerModel ?? (spec.id.includes(':') ? spec.id.slice(spec.id.indexOf(':') + 1) : spec.id);
}

function effortForModel(modelId: string): string | undefined {
  const spec = availableModels.find(m => m.id === modelId) ?? FALLBACK_MODELS.find(m => m.id === modelId);
  if (!spec || spec.effortLevels.length === 0) return undefined;
  return spec.effortLevels.includes(currentEffort)
    ? currentEffort
    : spec.effortLevels.includes('high')
      ? 'high'
      : spec.effortLevels[spec.effortLevels.length - 1];
}

/**
 * 활성 프로바이더에서 사용 가능한 모델 목록을 동적으로 가져와 캐시한다.
 * 실패하면 폴백 목록을 유지한다.
 */
export async function loadModelsFromCli(): Promise<void> {
  try {
    const models = await getModelCatalog().listModels();
    if (models.length > 0) {
      availableModels = models as ModelSpec[];
      reconcileSelection();
      loadedFromCli = true;
      log.info({ count: availableModels.length, models: availableModels.map(m => m.id) }, 'Loaded models from provider');
    } else {
      log.warn({}, 'Provider returned no models — keeping fallback list');
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to load models from provider — keeping fallback list');
  }
}

export const modelConfig = {
  getModel(): string { return currentModel; },
  getProvider(): string | undefined { return resolveModelSpec().provider; },
  getModelIdForAgent(agentName: string): string { return resolveModelSpec(agentName).id; },
  getFallbackModel(): string | undefined { return fallbackModel; },
  getAgentModels(): Record<string, string> { return { ...agentModels }; },
  getProviderForAgent(agentName: string): string | undefined { return resolveModelSpec(agentName).provider; },
  getModelForAgent(agentName: string): string { return rawModelId(resolveModelSpec(agentName)); },
  getModelForModelId(modelId: string): string { return rawModelId(resolveModelSpecById(modelId)); },
  getEffort(): string { return currentEffort; },

  /** query 옵션으로 넘길 effort. 현재 모델이 effort를 지원하지 않으면 undefined. */
  getEffortOption(): string | undefined {
    return effortForModel(currentModel);
  },

  getEffortOptionForAgent(agentName: string): string | undefined {
    return effortForModel(resolveModelSpec(agentName).id);
  },

  getEffortOptionForModelId(modelId: string): string | undefined {
    return effortForModel(resolveModelSpecById(modelId).id);
  },

  isLoadedFromCli(): boolean { return loadedFromCli; },

  set(model: string, effort: string, options: { fallbackModel?: string; agentModels?: Record<string, string>; persist?: boolean } = {}): void {
    const spec = availableModels.find(m => m.id === model);
    if (!spec) throw new Error(`Unknown model: ${model}`);
    const nextFallbackModel = Object.prototype.hasOwnProperty.call(options, 'fallbackModel') ? options.fallbackModel || undefined : fallbackModel;
    if (nextFallbackModel && !availableModels.find(m => m.id === nextFallbackModel)) {
      throw new Error(`Unknown fallback model: ${nextFallbackModel}`);
    }
    const nextAgentModels = options.agentModels ?? agentModels;
    for (const [agent, agentModel] of Object.entries(nextAgentModels)) {
      if (agentModel && !availableModels.find(m => m.id === agentModel)) {
        throw new Error(`Unknown model for ${agent}: ${agentModel}`);
      }
    }
    // 모델이 effort 레벨을 선언한 경우에만 검증한다.
    if (spec.effortLevels.length > 0 && !spec.effortLevels.includes(effort)) {
      throw new Error(`Model ${model} does not support effort level: ${effort}`);
    }
    currentModel = model;
    currentEffort = effort;
    fallbackModel = nextFallbackModel;
    agentModels = Object.fromEntries(Object.entries(nextAgentModels).filter(([, value]) => Boolean(value)));
    if (options.persist) {
      appConfig.save({
        model: currentModel,
        fallbackModel,
        effort: currentEffort,
        agentModels,
      } satisfies RuntimeConfig);
    }
  },

  stats(): { model: string; fallbackModel?: string; agentModels: Record<string, string>; effort: string; availableModels: ModelSpec[]; loadedFromCli: boolean; configPath: string } {
    return { model: currentModel, fallbackModel, agentModels: { ...agentModels }, effort: currentEffort, availableModels, loadedFromCli, configPath: appConfig.path() };
  },
};
