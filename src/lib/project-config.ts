import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 대상 프로젝트가 자기 검증 방법을 선언하는 파일.
 *
 * 이 파일이 없으면 프로젝트 설정 기반 verify/runtime 게이트는 비활성화된다.
 * 기본 보호 경로와 테스트 무결성 검사는 설정 없이도 동작한다.
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
  /** planner 전에 기준선 검증을 실행한다. */
  baseline?: boolean;
  /** JUnit XML 실행 수를 기준선과 비교한다. */
  report?: { format: 'junit-xml'; paths: string[] };
}

export interface RoleBoundaryConfig {
  /** test 단계가 수정해도 되는 경로 glob. 비어 있으면 역할 경계 검사를 건너뛴다. */
  testGlobs: string[];
  /** 오탐으로 판정된 경로 glob (생성물, 캐시 등). */
  ignoreGlobs: string[];
}

export interface ProtectConfig {
  /** 가드 설정과 검증 스크립트는 기본 목록을 포함해 수정할 수 없다. */
  globs: string[];
}

export interface RuntimeConfig {
  /** 실행 중인 프로젝트 런타임을 준비·정리하는 명령. */
  up: string;
  down: string;
  healthcheck: {
    url: string;
    timeoutMs: number;
  };
  /** 런타임에서 수행할 결정적 smoke/check 스크립트 경로. */
  checks: string[];
}

export interface WorkflowConfig {
  /** 서버 재시작 뒤 대시보드 spec 워크플로우를 안전한 체크포인트에서 이어간다. */
  resumeOnRestart: boolean;
}

export interface DeliveryConfig {
  /** 성공 결과를 로컬에 남기거나 GitHub PR로 전달한다. */
  mode: 'local' | 'pull-request';
  /** 생략 시 GitHub 저장소 기본 브랜치를 사용한다. */
  baseBranch?: string;
  /** 자동 머지 자격 dry-run을 켠다. */
  autoMerge?: { enabled: boolean; requestMerge: boolean };
}

export interface ProjectConfig {
  version: 1;
  verify?: VerifyConfig;
  roleBoundary?: RoleBoundaryConfig;
  protect?: ProtectConfig;
  runtime?: RuntimeConfig;
  workflow?: WorkflowConfig;
  delivery?: DeliveryConfig;
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
  if (verify.baseline !== undefined && typeof verify.baseline !== 'boolean') {
    throw new ProjectConfigError(configPath, 'verify.baseline must be a boolean');
  }
  let report: VerifyConfig['report'];
  if (verify.report !== undefined) {
    const candidate = asRecord(verify.report);
    if (!candidate || candidate.format !== 'junit-xml') {
      throw new ProjectConfigError(configPath, 'verify.report.format must be junit-xml');
    }
    const paths = parseGlobs(candidate.paths, 'verify.report.paths', configPath);
    if (paths.length === 0 || paths.some((path) => path.startsWith('/') || path.split(/[\\/]/).includes('..'))) {
      throw new ProjectConfigError(configPath, 'verify.report.paths must contain project-relative paths without ..');
    }
    if (verify.baseline !== true) {
      throw new ProjectConfigError(configPath, 'verify.report requires verify.baseline=true');
    }
    report = { format: 'junit-xml', paths };
  }
  return {
    command: verify.command.trim(),
    timeoutMs: verify.timeoutMs === undefined ? DEFAULT_VERIFY_TIMEOUT_MS : Math.floor(verify.timeoutMs),
    ...(verify.baseline === true ? { baseline: true } : {}),
    ...(report ? { report } : {}),
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

function parseProtect(value: unknown, configPath: string): ProtectConfig | undefined {
  if (value === undefined) return undefined;
  const protect = asRecord(value);
  if (!protect) throw new ProjectConfigError(configPath, 'protect must be an object');
  return { globs: parseGlobs(protect.globs, 'protect.globs', configPath) };
}

function parseRuntime(value: unknown, configPath: string): RuntimeConfig | undefined {
  if (value === undefined) return undefined;
  const runtime = asRecord(value);
  if (!runtime) throw new ProjectConfigError(configPath, 'runtime must be an object');

  const command = (field: 'up' | 'down'): string => {
    const candidate = runtime[field];
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new ProjectConfigError(configPath, `runtime.${field} must be a non-empty string`);
    }
    return candidate.trim();
  };

  const healthcheck = asRecord(runtime.healthcheck);
  if (!healthcheck) throw new ProjectConfigError(configPath, 'runtime.healthcheck must be an object');
  let url: URL;
  if (typeof healthcheck.url !== 'string') {
    throw new ProjectConfigError(configPath, 'runtime.healthcheck.url must be an HTTP(S) URL');
  }
  try { url = new URL(healthcheck.url); } catch {
    throw new ProjectConfigError(configPath, 'runtime.healthcheck.url must be an HTTP(S) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProjectConfigError(configPath, 'runtime.healthcheck.url must use http or https');
  }
  if (healthcheck.timeoutMs !== undefined &&
    (typeof healthcheck.timeoutMs !== 'number' || !Number.isFinite(healthcheck.timeoutMs) || healthcheck.timeoutMs <= 0)) {
    throw new ProjectConfigError(configPath, 'runtime.healthcheck.timeoutMs must be a positive number');
  }
  const checks = parseGlobs(runtime.checks, 'runtime.checks', configPath);
  if (checks.some((check) => check.startsWith('/') || check.split(/[\\/]/).includes('..') || /[*?\[\]]/.test(check))) {
    throw new ProjectConfigError(configPath, 'runtime.checks entries must stay inside the project directory');
  }
  return {
    up: command('up'),
    down: command('down'),
    healthcheck: {
      url: url.toString(),
      timeoutMs: healthcheck.timeoutMs === undefined ? 120_000 : Math.floor(healthcheck.timeoutMs),
    },
    checks,
  };
}

function parseWorkflow(value: unknown, configPath: string): WorkflowConfig | undefined {
  if (value === undefined) return undefined;
  const workflow = asRecord(value);
  if (!workflow) throw new ProjectConfigError(configPath, 'workflow must be an object');
  if (workflow.resumeOnRestart !== undefined && typeof workflow.resumeOnRestart !== 'boolean') {
    throw new ProjectConfigError(configPath, 'workflow.resumeOnRestart must be a boolean');
  }
  return { resumeOnRestart: workflow.resumeOnRestart === true };
}

function parseDelivery(value: unknown, configPath: string): DeliveryConfig | undefined {
  if (value === undefined) return undefined;
  const delivery = asRecord(value);
  if (!delivery) throw new ProjectConfigError(configPath, 'delivery must be an object');
  const mode = delivery.mode === undefined ? 'local' : delivery.mode;
  if (mode !== 'local' && mode !== 'pull-request') {
    throw new ProjectConfigError(configPath, 'delivery.mode must be local or pull-request');
  }
  if (delivery.baseBranch !== undefined &&
    (typeof delivery.baseBranch !== 'string' || !delivery.baseBranch.trim())) {
    throw new ProjectConfigError(configPath, 'delivery.baseBranch must be a non-empty string');
  }
  let autoMerge: DeliveryConfig['autoMerge'];
  if (delivery.autoMerge !== undefined) {
    const candidate = asRecord(delivery.autoMerge);
    if (!candidate || (candidate.enabled !== undefined && typeof candidate.enabled !== 'boolean')) {
      throw new ProjectConfigError(configPath, 'delivery.autoMerge.enabled must be a boolean');
    }
    if (candidate.requestMerge !== undefined && typeof candidate.requestMerge !== 'boolean') {
      throw new ProjectConfigError(configPath, 'delivery.autoMerge.requestMerge must be a boolean');
    }
    autoMerge = { enabled: candidate.enabled === true, requestMerge: candidate.requestMerge === true };
    if (autoMerge.requestMerge && !autoMerge.enabled) {
      throw new ProjectConfigError(configPath, 'delivery.autoMerge.requestMerge requires delivery.autoMerge.enabled=true');
    }
  }
  if ((autoMerge?.enabled || autoMerge?.requestMerge) && mode !== 'pull-request') {
    throw new ProjectConfigError(configPath, 'delivery.autoMerge.enabled requires delivery.mode=pull-request');
  }
  return {
    mode,
    ...(typeof delivery.baseBranch === 'string' ? { baseBranch: delivery.baseBranch.trim() } : {}),
    ...(autoMerge ? { autoMerge } : {}),
  };
}

/**
 * `<projectDir>/.auto-dev/project.json` 을 읽어 검증한다.
 *
 * - 파일이 없으면 `undefined` (설정 없는 프로젝트는 기존 동작 유지)
 * - 읽을 수 없거나 스키마가 틀리면 `ProjectConfigError`
 *
 * 모르는 최상위 필드는 무시해 이후 버전의 설정을 읽을 수 있게 한다.
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
    protect: parseProtect(root.protect, configPath),
    ...(root.runtime === undefined ? {} : { runtime: parseRuntime(root.runtime, configPath) }),
    ...(root.workflow === undefined ? {} : { workflow: parseWorkflow(root.workflow, configPath) }),
    ...(root.delivery === undefined ? {} : { delivery: parseDelivery(root.delivery, configPath) }),
  };
}

/** 역할 경계 검사를 실제로 수행할 수 있는 설정인지. testGlobs 가 없으면 판정 기준이 없다. */
export function roleBoundaryEnabled(config: ProjectConfig | undefined): config is ProjectConfig & { roleBoundary: RoleBoundaryConfig } {
  return Boolean(config?.roleBoundary?.testGlobs.length);
}
