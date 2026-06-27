import { resolve } from 'path';
import { existsSync, readdirSync } from 'fs';

/** 모든 작업 디렉토리의 기준이 되는 워크스페이스 루트 (환경변수로 제어). */
export const WORKSPACE_ROOT = process.env.AUTO_DEV_WORKSPACE_ROOT ?? './data/workspace';

/**
 * 프로젝트명을 워크스페이스 루트 하위의 절대경로로 변환한다.
 * 비어 있으면 루트 자체를 반환한다. 경로 탈출(..)은 거부한다.
 */
export function resolveProjectDir(project?: string): string {
  const rootAbs = resolve(WORKSPACE_ROOT);
  const name = (project ?? '').trim();
  if (!name) return rootAbs;

  // 선행 구분자/상위참조 제거 후 결합
  const safe = name.replace(/^[/\\]+/, '').replace(/\.\.[/\\]?/g, '');
  const dir = resolve(rootAbs, safe);

  if (dir !== rootAbs && !dir.startsWith(rootAbs + '/')) {
    throw new Error(`Invalid project name: ${project}`);
  }
  return dir;
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
  const rootAbs = resolve(WORKSPACE_ROOT);
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
