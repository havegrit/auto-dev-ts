import type { ModelCatalog, ModelSpec } from '../types.js';
import { appConfig } from '../../lib/app-config.js';
import { execCommand } from './process.js';
import { log } from '../../lib/logger.js';

/** CLI 조회 실패 시 사용하는 폴백 목록. */
const DEFAULT_CODEX_MODELS: ModelSpec[] = [
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model',
    effortLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6-Terra',
    description: 'Balanced agentic coding model for everyday work',
    effortLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6-Luna',
    description: 'Fast and affordable agentic coding model',
    effortLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
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
];

interface CodexCatalogModel {
  slug: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
  supported_reasoning_levels?: Array<{ effort: string }>;
}

/**
 * `codex debug models` 는 codex CLI가 provider(ChatGPT 계정)로부터 실제로 받은 모델
 * 카탈로그를 그대로 JSON으로 찍어준다. 서버 시작 시 이걸로 목록을 동적으로 가져와,
 * 신규/폐지 모델이 코드 수정 없이 반영되게 한다. 실패하면 undefined — 호출부가
 * DEFAULT_CODEX_MODELS 폴백을 쓴다.
 */
async function fetchLiveCodexModels(): Promise<ModelSpec[] | undefined> {
  try {
    const result = await execCommand(
      process.env.AUTO_DEV_CODEX_COMMAND ?? 'codex',
      ['debug', 'models'],
      { cwd: process.cwd(), timeoutMs: 15_000 },
    );
    if (result.exitCode !== 0) {
      log.warn({ exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) }, 'codex debug models failed — keeping fallback list');
      return undefined;
    }
    const parsed = JSON.parse(result.stdout) as { models?: CodexCatalogModel[] };
    const models = (parsed.models ?? [])
      .filter(m => m.visibility === 'list' && m.slug)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((m): ModelSpec => ({
        id: m.slug,
        displayName: m.display_name ?? m.slug,
        description: m.description,
        effortLevels: ['none', ...(m.supported_reasoning_levels ?? []).map(l => l.effort)],
      }));
    return models.length > 0 ? models : undefined;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to run codex debug models — keeping fallback list');
    return undefined;
  }
}

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
    const base = (await fetchLiveCodexModels()) ?? DEFAULT_CODEX_MODELS;
    const configured = configuredModels().map(model => ({
      id: model,
      displayName: model.toUpperCase(),
      description: 'Codex CLI configured model',
      effortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    }));
    const merged = new Map<string, ModelSpec>();
    for (const model of [...base, ...configured]) merged.set(model.id, model);
    return [...merged.values()];
  },
};
