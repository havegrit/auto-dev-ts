import type { ModelCatalog, ModelSpec } from '../types.js';
import { execCommand } from './process.js';
import { log } from '../../lib/logger.js';

interface CodexCatalogModel {
  slug: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
  supported_reasoning_levels?: Array<{ effort: string }>;
}

/**
 * `codex debug models` 는 로그인된 ChatGPT 계정의 모델 카탈로그를 출력한다.
 * 계정에서 확인된 `visibility=list` 모델만 노출하고, 조회 실패 시에는
 * 정적 목록이나 저장 설정으로 확인되지 않은 모델을 보충하지 않는다.
 */
async function fetchLiveCodexModels(): Promise<ModelSpec[]> {
  try {
    const result = await execCommand(
      process.env.AUTO_DEV_CODEX_COMMAND ?? 'codex',
      ['debug', 'models'],
      { cwd: process.cwd(), timeoutMs: 15_000 },
    );
    if (result.exitCode !== 0) {
      log.warn({ exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) }, 'codex debug models failed — hiding unverified Codex models');
      return [];
    }
    const parsed = JSON.parse(result.stdout) as { models?: CodexCatalogModel[] };
    return (parsed.models ?? [])
      .filter(m => m.visibility === 'list' && m.slug)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((m): ModelSpec => ({
        id: m.slug,
        displayName: m.display_name ?? m.slug,
        description: m.description,
        effortLevels: ['none', ...(m.supported_reasoning_levels ?? []).map(l => l.effort)],
      }));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to run codex debug models — hiding unverified Codex models');
    return [];
  }
}

export const codexModelCatalog: ModelCatalog = {
  listModels: fetchLiveCodexModels,
};
