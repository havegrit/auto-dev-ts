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

/** 워크스페이스 루트 하위의 기존 프로젝트(디렉토리) 목록. */
export function listProjects(): string[] {
  const rootAbs = resolve(WORKSPACE_ROOT);
  if (!existsSync(rootAbs)) return [];
  try {
    return readdirSync(rootAbs, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}
