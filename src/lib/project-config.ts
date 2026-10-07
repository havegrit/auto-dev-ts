import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 대상 프로젝트가 자기 검증 방법을 선언하는 파일.
 *
 * 이 파일이 없으면 모든 게이트가 비활성화되고 workflow는 기존과 동일하게 동작한다.
 * 파일이 있는데 내용이 잘못되면 조용히 무시하지 않고 run을 실패시킨다 —
 * "검증한다고 선언했지만 실제로는 검증되지 않는" 상태가 가장 위험하기 때문이다.
 */
export const PROJECT_CONFIG_PATH = '.auto-dev/project.json';

/** verify 명령 기본 타임아웃 (15분). Gradle/Maven 풀빌드를 담을 수 있는 길이. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 900_000;

export interface VerifyConfig {
  /** bash -c 로 실행할 검증 명령. 종료 코드 0 이 유일한 통과 신호다. */
  command: string;
  timeoutMs: number;
}

export interface RoleBoundaryConfig {
  /** test 단계가 수정해도 되는 경로 glob. 비어 있으면 역할 경계 검사를 건너뛴다. */
  testGlobs: string[];
  /** 오탐으로 판정된 경로 glob (생성물, 캐시 등). */
  ignoreGlobs: string[];
}

export interface ProjectConfig {
  version: 1;
  verify?: VerifyConfig;
  roleBoundary?: RoleBoundaryConfig;
}

export class ProjectConfigError extends Error {
  constructor(readonly configPath: string, readonly reason: string) {
    super(`Invalid project config: ${configPath} — ${reason}`);
    this.name = 'ProjectConfigError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseGlobs(value: unknown, field: string, configPath: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new ProjectConfigError(configPath, `${field} must be an array of non-empty strings`);
  }
  return (value as string[]).map((entry) => entry.trim());
}

function parseVerify(value: unknown, configPath: string): VerifyConfig | undefined {
  if (value === undefined) return undefined;
  const verify = asRecord(value);
  if (!verify) throw new ProjectConfigError(configPath, 'verify must be an object');
  if (typeof verify.command !== 'string' || !verify.command.trim()) {
    throw new ProjectConfigError(configPath, 'verify.command must be a non-empty string');
  }
  if (verify.timeoutMs !== undefined &&
    (typeof verify.timeoutMs !== 'number' || !Number.isFinite(verify.timeoutMs) || verify.timeoutMs <= 0)) {
    throw new ProjectConfigError(configPath, 'verify.timeoutMs must be a positive number');
  }
  return {
    command: verify.command.trim(),
    timeoutMs: verify.timeoutMs === undefined ? DEFAULT_VERIFY_TIMEOUT_MS : Math.floor(verify.timeoutMs),
  };
}

function parseRoleBoundary(value: unknown, configPath: string): RoleBoundaryConfig | undefined {
  if (value === undefined) return undefined;
  const boundary = asRecord(value);
  if (!boundary) throw new ProjectConfigError(configPath, 'roleBoundary must be an object');
  return {
    testGlobs: parseGlobs(boundary.testGlobs, 'roleBoundary.testGlobs', configPath),
    ignoreGlobs: parseGlobs(boundary.ignoreGlobs, 'roleBoundary.ignoreGlobs', configPath),
  };
}

/**
 * `<projectDir>/.auto-dev/project.json` 을 읽어 검증한다.
 *
 * - 파일이 없으면 `undefined` (설정 없는 프로젝트는 기존 동작 유지)
 * - 읽을 수 없거나 스키마가 틀리면 `ProjectConfigError`
 *
 * 모르는 최상위 필드는 무시한다. Phase 3 의 `runtime` 같은 후속 필드가 들어와도
 * 구버전 오케스트레이터가 run 을 깨뜨리지 않게 하기 위한 전방 호환 장치다.
 */
export function loadProjectConfig(projectDir: string): ProjectConfig | undefined {
  const configPath = join(projectDir, PROJECT_CONFIG_PATH);
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ProjectConfigError(configPath, err instanceof Error ? err.message : String(err));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProjectConfigError(configPath, `not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }

  const root = asRecord(parsed);
  if (!root) throw new ProjectConfigError(configPath, 'root must be a JSON object');
  if (root.version !== 1) throw new ProjectConfigError(configPath, 'version must be 1');

  return {
    version: 1,
    verify: parseVerify(root.verify, configPath),
    roleBoundary: parseRoleBoundary(root.roleBoundary, configPath),
  };
}

/** 역할 경계 검사를 실제로 수행할 수 있는 설정인지. testGlobs 가 없으면 판정 기준이 없다. */
export function roleBoundaryEnabled(config: ProjectConfig | undefined): config is ProjectConfig & { roleBoundary: RoleBoundaryConfig } {
  return Boolean(config?.roleBoundary?.testGlobs.length);
}
