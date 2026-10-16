import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROJECT_CONTEXT_MAX_BYTES = 16 * 1024;

type ProjectContextOptions = {
  includeInstructions?: boolean;
  claudeMdLoadedBySdk?: boolean;
};

function readOptionalText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  let result = '';
  let size = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (size + characterBytes > maxBytes) break;
    result += character;
    size += characterBytes;
  }
  return result;
}

function limitProjectContext(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= PROJECT_CONTEXT_MAX_BYTES) return text;

  const marker = '\n\n[Project context truncated: combined files exceed 16 KiB.]';
  const contentLimit = PROJECT_CONTEXT_MAX_BYTES - Buffer.byteLength(marker, 'utf8');
  return `${truncateUtf8(text, contentLimit)}${marker}`;
}

/** 대상 저장소의 작업 규칙과 feature map을 에이전트 프롬프트에 넣는다. */
export function buildProjectContext(
  projectDir: string,
  options: ProjectContextOptions = {},
): string {
  const sections: string[] = [];

  if (options.includeInstructions !== false) {
    const agentsPath = join(projectDir, 'AGENTS.md');
    const agents = readOptionalText(agentsPath);
    if (agents !== undefined) {
      if (agents.trim()) sections.push(`### AGENTS.md\n\n${agents.trim()}`);
    } else if (!options.claudeMdLoadedBySdk) {
      const claude = readOptionalText(join(projectDir, 'CLAUDE.md'));
      if (claude?.trim()) sections.push(`### CLAUDE.md\n\n${claude.trim()}`);
    }
  }

  const featureMap = readOptionalText(join(projectDir, '.auto-dev', 'feature-map.md'));
  if (featureMap?.trim()) {
    sections.push(`### .auto-dev/feature-map.md\n\n${featureMap.trim()}`);
  }

  if (sections.length === 0) return '';
  return limitProjectContext(`## Project context\n\n${sections.join('\n\n')}`);
}
