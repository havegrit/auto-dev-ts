import { resolve, join, isAbsolute, sep } from 'path';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { createHash } from 'crypto';

/** 모든 작업 디렉토리의 기준이 되는 워크스페이스 루트 (환경변수로 제어). */
export const WORKSPACE_ROOT = process.env.AUTO_DEV_WORKSPACE_ROOT ?? './data/workspace';

/**
 * 선행 `~`(또는 `~/`)를 사용자 홈 디렉토리로 확장한다.
 * path.resolve 는 `~`를 확장하지 않아 cwd 하위로 잘못 결합되므로 먼저 처리한다.
 */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/** 환경변수에서 읽은 워크스페이스 루트의 절대경로 (~ 확장 적용). */
function rootAbsPath(): string {
  return resolve(expandHome(WORKSPACE_ROOT));
}

/**
 * 프로젝트명을 워크스페이스 루트 하위의 절대경로로 변환한다.
 * 비어 있으면 루트 자체를 반환하거나, seed 가 있으면 seed 기반 새 프로젝트 경로를 만든다.
 * project 입력은 워크스페이스 루트 하위 상대 경로로만 해석한다.
 */
export function resolveProjectDir(project?: string, seed?: string): string {
  const rootAbs = rootAbsPath();
  const name = (project ?? '').trim();
  if (!name) {
    const inferred = inferProjectName(seed);
    return inferred ? resolve(rootAbs, inferred) : rootAbs;
  }

  if (isAbsolute(name) || name === '~' || name.startsWith('~/') || name.startsWith('~\\')) {
    throw new Error(`Invalid project name: ${project}`);
  }

  const dir = resolve(rootAbs, name);
  if (dir !== rootAbs && !dir.startsWith(rootAbs + sep)) {
    throw new Error(`Invalid project name: ${project}`);
  }
  return dir;
}

export function inferProjectName(seed?: string): string {
  const text = (seed ?? '').trim();
  if (!text) return '';

  const heading = text.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  const firstLine = heading ?? text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  const slug = firstLine
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (slug) return slug;

  return `spec-${createHash('sha1').update(text).digest('hex').slice(0, 8)}`;
}

/** 프로젝트 목록에서 숨길 정크/빌드 산출물 디렉토리 이름 (소문자 비교). */
const JUNK_NAMES = new Set([
  '__macosx', 'node_modules', 'dist', 'build', 'out', 'target',
  'coverage', '__pycache__', '.next', '.cache', 'venv', '.venv',
]);

/**
 * 워크스페이스 루트 하위의 프로젝트 후보 목록.
 * 디렉토리를 먼저, 일반 파일을 그 다음 순서로 정렬해 반환한다.
 * 숨김(.)·언더스코어(_) 접두 항목과 알려진 정크 디렉토리는 제외한다.
 */
export function listProjects(): string[] {
  const rootAbs = rootAbsPath();
  if (!existsSync(rootAbs)) return [];
  try {
    const entries = readdirSync(rootAbs, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.') && !d.name.startsWith('_'))
      .filter((d) => !JUNK_NAMES.has(d.name.toLowerCase()));
    const dirs = entries.filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const files = entries.filter((d) => d.isFile()).map((d) => d.name).sort();
    return [...dirs, ...files];
  } catch {
    return [];
  }
}
