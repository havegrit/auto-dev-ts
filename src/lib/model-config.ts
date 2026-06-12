import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';

export interface ModelSpec {
  id: string;
  displayName: string;
  effortLevels: EffortLevel[];
}

export const AVAILABLE_MODELS: ModelSpec[] = [
  {
    id: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    effortLevels: ['low', 'medium', 'high', 'max'],
  },
  {
    id: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    effortLevels: ['low', 'medium', 'high'],
  },
  {
    id: 'claude-fable-5',
    displayName: 'Claude Fable 5',
    effortLevels: ['low', 'medium', 'high'],
  },
];

const DEFAULT_MODEL = process.env.AUTO_DEV_MODEL ?? 'claude-sonnet-4-6';
const DEFAULT_EFFORT = (process.env.AUTO_DEV_EFFORT ?? 'high') as EffortLevel;

let currentModel = DEFAULT_MODEL;
let currentEffort: EffortLevel = DEFAULT_EFFORT;

export const modelConfig = {
  getModel(): string { return currentModel; },
  getEffort(): EffortLevel { return currentEffort; },

  set(model: string, effort: EffortLevel): void {
    const spec = AVAILABLE_MODELS.find(m => m.id === model);
    if (!spec) throw new Error(`Unknown model: ${model}`);
    if (!spec.effortLevels.includes(effort)) {
      throw new Error(`Model ${model} does not support effort level: ${effort}`);
    }
    currentModel = model;
    currentEffort = effort;
  },

  stats(): { model: string; effort: EffortLevel; availableModels: ModelSpec[] } {
    return { model: currentModel, effort: currentEffort, availableModels: AVAILABLE_MODELS };
  },
};
