import { AsyncLocalStorage } from 'node:async_hooks';
import { getProviderModelCatalogs } from '../llm/registry.js';
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
  { id: 'anthropic:claude-sonnet-5', provider: 'anthropic', providerModel: 'claude-sonnet-5', displayName: 'anthropic / Claude Sonnet 5', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'anthropic:claude-fable-5', provider: 'anthropic', providerModel: 'claude-fable-5', displayName: 'anthropic / Claude Fable 5', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'anthropic:claude-haiku-4-5-20251001', provider: 'anthropic', providerModel: 'claude-haiku-4-5-20251001', displayName: 'anthropic / Claude Haiku 4.5', effortLevels: [] },
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
let agentEfforts: Record<string, string> = storedConfig.agentEfforts ?? {};
let loadedFromCli = false;
const scopedAgentModels = new AsyncLocalStorage<Record<string, string>>();

// 역할별 기본값: 비용이 큰 판단/구현은 상위 모델, 단순 분류/설정은 경량 모델 우선.
const AGENT_MODEL_PREFERENCES: Record<string, string[]> = {
  clarifier: ['haiku', 'sonnet'],
  planner: ['sonnet', 'opus'],
  scaffold: ['opus', 'sonnet'],
  test: ['sonnet', 'opus'],
  review: ['opus', 'sonnet'],
  cicd: ['sonnet', 'haiku'],
};
const CONFIG_AGENT_NAMES = Object.keys(AGENT_MODEL_PREFERENCES);

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

function preferredModel(agentName: string): ModelSpec | undefined {
  const preferences = AGENT_MODEL_PREFERENCES[agentName] ?? [];
  return availableModels.find((model) => {
    if (!supportsAgentRuns(model)) return false;
    const text = `${model.id} ${model.displayName}`.toLowerCase();
    return preferences.some((preference) => text.includes(preference));
  });
}

function supportsAgentRuns(spec: ModelSpec): boolean {
  return spec.provider !== 'openai-compatible';
}

interface ModelResolutionOptions {
  agentModels?: Record<string, string>;
  currentModel?: string;
  fallbackModel?: string;
  ignoreScopedOverrides?: boolean;
}

function resolveModelSpec(agentName?: string, options: ModelResolutionOptions = {}): ModelSpec {
  const scopedModel = agentName && !options.ignoreScopedOverrides ? scopedAgentModels.getStore()?.[agentName] : undefined;
  const configuredAgentModels = options.agentModels ?? agentModels;
  const agentModel = agentName ? scopedModel ?? configuredAgentModels[agentName] ?? process.env[envKeyForAgent(agentName)] : undefined;
  const preferred = agentName ? preferredModel(agentName)?.id : undefined;
  const selectedModel = options.currentModel ?? currentModel;
  const selectedFallback = Object.prototype.hasOwnProperty.call(options, 'fallbackModel') ? options.fallbackModel : fallbackModel;
  const candidates = agentModel !== undefined
    ? [agentModel, preferred, selectedFallback, selectedModel]
    : [preferred, selectedModel, selectedFallback];
  for (const id of candidates) {
    const spec = availableModel(id);
    if (spec && (!agentName || supportsAgentRuns(spec))) return spec;
  }
  const runnable = firstRunnableModel();
  if (agentName) {
    const agentRunnable = availableModels.find(supportsAgentRuns) ?? FALLBACK_MODELS.find(supportsAgentRuns);
    if (agentRunnable) return agentRunnable;
  }
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

function effortForModel(modelId: string, effort = currentEffort): string | undefined {
  const spec = availableModels.find(m => m.id === modelId) ?? FALLBACK_MODELS.find(m => m.id === modelId);
  if (!spec || spec.effortLevels.length === 0) return undefined;
  return spec.effortLevels.includes(effort)
    ? effort
    : spec.effortLevels.includes('high')
      ? 'high'
      : spec.effortLevels[spec.effortLevels.length - 1];
}

/** Provider 조회 실패 중에는 저장한 선택을 임시 목록에 남겨 다음 성공 조회 때까지 보존한다. */
function configuredModelsForProvider(provider: string): ModelSpec[] {
  const config = appConfig.get();
  const defaultProvider = process.env.AUTO_DEV_PROVIDER ?? 'anthropic';
  const configuredIds = [
    config.model,
    config.fallbackModel,
    ...Object.values(config.agentModels ?? {}),
    process.env.AUTO_DEV_MODEL,
    process.env.AUTO_DEV_FALLBACK_MODEL,
    ...Object.entries(process.env)
      .filter(([key]) => key.startsWith('AUTO_DEV_AGENT_') && key.endsWith('_MODEL'))
      .map(([, value]) => value),
  ];
  const byId = new Map<string, ModelSpec>();
  for (const configuredId of configuredIds) {
    if (!configuredId) continue;
    const separator = configuredId.indexOf(':');
    const configuredProvider = separator > 0 ? configuredId.slice(0, separator) : defaultProvider;
    if (configuredProvider !== provider) continue;
    const providerModel = separator > 0 ? configuredId.slice(separator + 1) : configuredId;
    const id = `${provider}:${providerModel}`;
    if (availableModel(id) || byId.has(id)) continue;
    const retainedEfforts = [
      ...(config.model === configuredId ? [config.effort] : []),
      ...Object.entries(config.agentModels ?? {}).flatMap(([agent, model]) => model === configuredId && config.agentEfforts?.[agent] ? [config.agentEfforts[agent]] : []),
    ].filter((effort): effort is string => Boolean(effort));
    byId.set(id, {
      id,
      provider,
      providerModel,
      displayName: `${provider} / ${providerModel}`,
      description: 'Previously configured model; provider catalog temporarily unavailable',
      effortLevels: [...new Set(retainedEfforts)],
    });
  }
  return [...byId.values()];
}

/**
 * 활성 프로바이더에서 사용 가능한 모델 목록을 동적으로 가져와 캐시한다.
 * 실패하면 폴백 목록을 유지한다.
 */
export async function loadModelsFromCli(): Promise<void> {
  try {
    const catalogs = await getProviderModelCatalogs();
    const modelsByProvider = new Map<string, ModelSpec[]>();
    for (const [provider, models] of Object.entries(FALLBACK_MODELS.reduce<Record<string, ModelSpec[]>>((groups, model) => {
      const name = model.provider ?? 'unknown';
      (groups[name] ??= []).push(model);
      return groups;
    }, {}))) {
      modelsByProvider.set(provider, models);
    }

    const previousModels = new Map<string, ModelSpec[]>();
    for (const model of availableModels) {
      const provider = model.provider ?? (model.id.includes(':') ? model.id.split(':', 1)[0] : 'unknown');
      const providerModels = previousModels.get(provider) ?? [];
      providerModels.push(model);
      previousModels.set(provider, providerModels);
    }
    for (const [provider, models] of previousModels) modelsByProvider.set(provider, models);

    let authoritativeProviderCount = 0;
    const failedProviders = new Set<string>();
    for (const [provider, result] of Object.entries(catalogs)) {
      if (result.authoritative) {
        modelsByProvider.set(provider, result.models);
        authoritativeProviderCount += 1;
        log.info({ provider, count: result.models.length }, 'Updated provider model catalog');
      } else {
        failedProviders.add(provider);
        const previousProviderModels = modelsByProvider.get(provider) ?? [];
        const previousIds = new Set(previousProviderModels.map(model => model.id));
        modelsByProvider.set(provider, [
          ...previousProviderModels,
          ...configuredModelsForProvider(provider).filter(model => !previousIds.has(model.id)),
        ]);
        log.warn({ provider, err: result.error }, 'Provider model catalog unavailable — keeping previous list');
      }
    }

    availableModels = [...modelsByProvider.values()].flat();
    reconcileSelection();
    reconcileStoredSelections(failedProviders);
    if (authoritativeProviderCount > 0) {
      loadedFromCli = true;
      log.info({ count: availableModels.length, models: availableModels.map(m => m.id) }, 'Loaded models from provider');
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to load models from provider — keeping fallback list');
  }
}

/** 신뢰 가능한 새 카탈로그에서 사라진 모델과 호환되지 않는 저장 설정을 정리한다. */
function reconcileStoredSelections(failedProviders: Set<string>): void {
  const stored = appConfig.get();
  const providerOf = (model: string) => model.includes(':') ? model.split(':', 1)[0] : process.env.AUTO_DEV_PROVIDER ?? 'anthropic';
  const beforeModel = currentModel;
  const beforeEffort = currentEffort;
  const beforeFallback = fallbackModel;

  if (fallbackModel && !failedProviders.has(providerOf(fallbackModel)) && !availableModel(fallbackModel)) fallbackModel = undefined;
  agentModels = Object.fromEntries(Object.entries(agentModels).filter(([, model]) => failedProviders.has(providerOf(model)) || Boolean(availableModel(model))));

  const currentSpec = availableModel(currentModel);
  if (currentSpec && currentSpec.effortLevels.length > 0 && !currentSpec.effortLevels.includes(currentEffort)) {
    currentEffort = currentSpec.effortLevels.includes('high') ? 'high' : currentSpec.effortLevels[currentSpec.effortLevels.length - 1];
  }

  agentEfforts = Object.fromEntries(Object.entries(agentEfforts).filter(([agent, effort]) => {
    const spec = resolveModelSpec(agent, { ignoreScopedOverrides: true });
    return CONFIG_AGENT_NAMES.includes(agent) && (failedProviders.has(spec.provider ?? '') || spec.effortLevels.includes(effort));
  }));

  const storedAgentModels = Object.fromEntries(Object.entries(stored.agentModels ?? {}).filter(([, model]) => failedProviders.has(providerOf(model)) || Boolean(availableModel(model))));
  const storedAgentEfforts = Object.fromEntries(Object.entries(stored.agentEfforts ?? {}).filter(([agent, effort]) => {
    const spec = resolveModelSpec(agent, { agentModels: storedAgentModels, ignoreScopedOverrides: true });
    return CONFIG_AGENT_NAMES.includes(agent) && (failedProviders.has(spec.provider ?? '') || spec.effortLevels.includes(effort));
  }));
  const storedModelInvalid = Boolean(stored.model && !failedProviders.has(providerOf(stored.model)) && !availableModel(stored.model));
  const storedFallbackInvalid = Boolean(stored.fallbackModel && !failedProviders.has(providerOf(stored.fallbackModel)) && !availableModel(stored.fallbackModel));
  const storedEffortInvalid = Boolean(stored.effort && currentSpec && currentSpec.effortLevels.length > 0 && !currentSpec.effortLevels.includes(stored.effort));
  const agentModelsChanged = JSON.stringify(storedAgentModels) !== JSON.stringify(stored.agentModels ?? {});
  const agentEffortsChanged = JSON.stringify(storedAgentEfforts) !== JSON.stringify(stored.agentEfforts ?? {});
  const configNeedsCleanup = storedModelInvalid || storedFallbackInvalid || storedEffortInvalid || agentModelsChanged || agentEffortsChanged
    || (stored.model !== undefined && beforeModel !== currentModel)
    || (stored.effort !== undefined && beforeEffort !== currentEffort)
    || (stored.fallbackModel !== undefined && beforeFallback !== fallbackModel);

  if (configNeedsCleanup) {
    const nextConfig: RuntimeConfig = { ...stored };
    if (stored.model && storedModelInvalid) nextConfig.model = currentModel;
    if (stored.fallbackModel && storedFallbackInvalid) delete nextConfig.fallbackModel;
    if (stored.effort && (storedEffortInvalid || beforeEffort !== currentEffort)) nextConfig.effort = currentEffort;
    if (stored.agentModels) {
      if (Object.keys(storedAgentModels).length > 0) nextConfig.agentModels = storedAgentModels;
      else delete nextConfig.agentModels;
    }
    if (stored.agentEfforts) {
      if (Object.keys(storedAgentEfforts).length > 0) nextConfig.agentEfforts = storedAgentEfforts;
      else delete nextConfig.agentEfforts;
    }
    appConfig.save(nextConfig);
  }
}

/** 실행 단위 모델 오버라이드를 비동기 호출 트리 안에서만 적용한다. */
export function withAgentModelOverrides<T>(
  overrides: Record<string, string> | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return overrides && Object.keys(overrides).length > 0
    ? scopedAgentModels.run({ ...overrides }, run)
    : run();
}

export const modelConfig = {
  getModel(): string { return currentModel; },
  getProvider(): string | undefined { return resolveModelSpec().provider; },
  getModelIdForAgent(agentName: string): string { return resolveModelSpec(agentName).id; },
  getFallbackModel(): string | undefined { return fallbackModel; },
  getAgentModels(): Record<string, string> {
    return Object.fromEntries(CONFIG_AGENT_NAMES.map((agent) => [agent, resolveModelSpec(agent).id]));
  },
  getAgentEfforts(): Record<string, string> { return { ...agentEfforts }; },
  getProviderForAgent(agentName: string): string | undefined { return resolveModelSpec(agentName).provider; },
  getModelForAgent(agentName: string): string { return rawModelId(resolveModelSpec(agentName)); },
  getModelForModelId(modelId: string): string { return rawModelId(resolveModelSpecById(modelId)); },
  getEffort(): string { return currentEffort; },

  /** query 옵션으로 넘길 effort. 현재 모델이 effort를 지원하지 않으면 undefined. */
  getEffortOption(): string | undefined {
    return effortForModel(currentModel);
  },

  getEffortOptionForAgent(agentName: string): string | undefined {
    const spec = resolveModelSpec(agentName);
    const selectedEffort = agentEfforts[agentName];
    return selectedEffort && spec.effortLevels.includes(selectedEffort) ? selectedEffort : undefined;
  },

  getEffortOptionForModelId(modelId: string): string | undefined {
    return effortForModel(resolveModelSpecById(modelId).id);
  },

  hasRunnableModel(modelId: string): boolean {
    const spec = availableModel(modelId);
    return Boolean(spec && supportsAgentRuns(spec));
  },

  isLoadedFromCli(): boolean { return loadedFromCli; },

  set(model: string, effort: string, options: { fallbackModel?: string; agentModels?: Record<string, string>; agentEfforts?: Record<string, string>; persist?: boolean } = {}): void {
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
    const nextAgentEfforts = options.agentEfforts ?? agentEfforts;
    for (const [agent, agentEffort] of Object.entries(nextAgentEfforts)) {
      if (!CONFIG_AGENT_NAMES.includes(agent)) throw new Error(`Unknown agent: ${agent}`);
      const agentSpec = resolveModelSpec(agent, {
        agentModels: nextAgentModels,
        currentModel: model,
        fallbackModel: nextFallbackModel,
        ignoreScopedOverrides: true,
      });
      if (!agentSpec.effortLevels.includes(agentEffort)) {
        throw new Error(`Model ${agentSpec.id} does not support effort level: ${agentEffort}`);
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
    agentEfforts = Object.fromEntries(Object.entries(nextAgentEfforts).filter(([, value]) => Boolean(value)));
    if (options.persist) {
      appConfig.save({
        model: currentModel,
        fallbackModel,
        effort: currentEffort,
        agentModels,
        agentEfforts,
        autoMergeEnabled: appConfig.get().autoMergeEnabled ?? false,
      } satisfies RuntimeConfig);
    }
  },

  stats(): { model: string; fallbackModel?: string; agentModels: Record<string, string>; agentEfforts: Record<string, string>; effort: string; availableModels: ModelSpec[]; loadedFromCli: boolean; configPath: string } {
    return { model: currentModel, fallbackModel, agentModels: this.getAgentModels(), agentEfforts: this.getAgentEfforts(), effort: currentEffort, availableModels, loadedFromCli, configPath: appConfig.path() };
  },
};
