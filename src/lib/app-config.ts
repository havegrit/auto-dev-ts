import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export interface RuntimeConfig {
  model?: string;
  fallbackModel?: string;
  effort?: string;
  agentModels?: Record<string, string>;
}

const CONFIG_PATH = process.env.AUTO_DEV_CONFIG_PATH ?? './data/config.json';

function sanitizeConfig(input: unknown): RuntimeConfig {
  if (!input || typeof input !== 'object') return {};
  const raw = input as Record<string, unknown>;
  const agentModels: Record<string, string> = {};
  if (raw.agentModels && typeof raw.agentModels === 'object') {
    for (const [agent, model] of Object.entries(raw.agentModels as Record<string, unknown>)) {
      if (typeof model === 'string' && model.trim()) agentModels[agent] = model.trim();
    }
  }
  return {
    ...(typeof raw.model === 'string' && raw.model.trim() ? { model: raw.model.trim() } : {}),
    ...(typeof raw.fallbackModel === 'string' && raw.fallbackModel.trim() ? { fallbackModel: raw.fallbackModel.trim() } : {}),
    ...(typeof raw.effort === 'string' && raw.effort.trim() ? { effort: raw.effort.trim() } : {}),
    ...(Object.keys(agentModels).length > 0 ? { agentModels } : {}),
  };
}

function readConfig(): RuntimeConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return sanitizeConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')));
  } catch {
    return {};
  }
}

let currentConfig = readConfig();

function writeConfig(config: RuntimeConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, CONFIG_PATH);
}

export const appConfig = {
  get(): RuntimeConfig {
    return { ...currentConfig, agentModels: { ...(currentConfig.agentModels ?? {}) } };
  },

  save(next: RuntimeConfig): RuntimeConfig {
    currentConfig = sanitizeConfig(next);
    writeConfig(currentConfig);
    return this.get();
  },

  path(): string {
    return CONFIG_PATH;
  },
};
