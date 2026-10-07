import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RoleBoundaryConfig } from './project-config.js';

const execFileAsync = promisify(execFile);

/** 경로 → 내용 해시. 삭제된 경로는 DELETED 표식을 갖는다. */
export type WorkspaceSnapshot = Map<string, string>;

const DELETED = '<deleted>';

/**
 * glob 을 정규식으로 바꾼다. 지원 문법은 `**`, `*`, `?` 뿐이다.
 *
 * - `**\/` — 디렉토리 0개 이상 (`**\/*.test.ts` 가 `a.test.ts` 와 `src/a.test.ts` 둘 다 매치)
 * - `**`   — 구분자 포함 임의 문자열
 * - `*`    — 구분자를 넘지 않는 임의 문자열
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { out += '(?:[^/]+/)*'; i += 2; }
        else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') { out += '[^/]'; continue; }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** `git status --porcelain -z` 레코드에서 경로만 뽑는다 (rename/copy 는 양쪽 경로 모두). */
function parseStatusPaths(stdout: string): string[] {
  const records = stdout.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    paths.push(record.slice(3));
    // rename/copy 는 다음 레코드가 원본 경로다.
    if (code.includes('R') || code.includes('C')) {
      const origin = records[++i];
      if (origin) paths.push(origin);
    }
  }
  return paths;
}

async function hashFile(projectDir: string, path: string): Promise<string> {
  try {
    const content = await readFile(join(projectDir, path));
    return createHash('sha1').update(content).digest('hex');
  } catch {
    return DELETED;
  }
}

/**
 * 변경·미추적 파일의 내용 해시 스냅샷.
 *
 * 파일 이름 목록만으로는 부족하다. test 단계가 실행될 때 scaffold 가 이미 소스를
 * 바꿔 둔 상태이므로, 같은 경로의 내용이 또 바뀌었는지를 봐야 한다.
 * gitignore 된 빌드 산출물은 `git status` 가 애초에 보고하지 않으므로 자동 제외된다.
 *
 * git 저장소가 아니면 `undefined` — 호출부가 검사를 건너뛰고 경고를 남긴다.
 */
export async function snapshotWorkspace(projectDir: string): Promise<WorkspaceSnapshot | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['-C', projectDir, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch {
    return undefined;
  }
  const snapshot: WorkspaceSnapshot = new Map();
  for (const path of parseStatusPaths(stdout)) {
    if (!snapshot.has(path)) snapshot.set(path, await hashFile(projectDir, path));
  }
  return snapshot;
}

/**
 * 두 스냅샷 사이에 내용이 바뀐 경로 중 테스트 경로도 무시 경로도 아닌 것들.
 *
 * 비어 있지 않다면 test 단계가 프로덕션 소스를 건드렸다는 뜻이다.
 * 되돌리지는 않고 보고만 한다 — 오케스트레이터가 워크스페이스를 임의로 수정하면
 * 사람이 원인을 추적할 근거가 사라진다.
 */
export function findRoleBoundaryViolations(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  config: RoleBoundaryConfig,
): string[] {
  const touched = new Set<string>();
  for (const [path, hash] of after) {
    if (before.get(path) !== hash) touched.add(path);
  }
  // before 에만 있던 경로는 내용이 HEAD 상태로 되돌려졌거나 삭제된 것이다.
  for (const path of before.keys()) {
    if (!after.has(path)) touched.add(path);
  }
  return [...touched]
    .filter((path) => !matchesAnyGlob(path, config.testGlobs) && !matchesAnyGlob(path, config.ignoreGlobs))
    .sort();
}
