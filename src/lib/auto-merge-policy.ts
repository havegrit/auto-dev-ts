import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SPECS } from '../agents/specs.js';
import type { ProjectConfig } from './project-config.js';

export const AUTO_MERGE_POLICY_VERSION = 'auto-merge-policy-v1';
export const AUTO_MERGE_EVAL_STREAK_MIN = 20;
export const AUTO_MERGE_EVAL_CASE_MIN = 10;
export const AUTO_MERGE_LIVE_PR_STREAK_MIN = 10;
export const AUTO_MERGE_STABILITY_DAYS = 14;

export type AutoMergeRiskCategory = 'docs' | 'dependency-patch';
export type AutoMergeClassification = AutoMergeRiskCategory | 'ineligible';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../prompts');
const DOCS_FILE_ALLOWLIST = /^(?:README(?:\.[A-Za-z0-9_-]+)?(?:\.md)?|CHANGELOG(?:\.[A-Za-z0-9_-]+)?)$/;
const DEPENDENCY_FILE_ALLOWLIST = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 경로 전체가 단일 보호 allowlist에 들어갈 때만 저위험으로 분류한다. */
export function classifyAutoMergeFiles(files: string[]): AutoMergeClassification {
  if (files.length === 0) return 'ineligible';
  const normalized = files.map(file => file.replaceAll('\\', '/'));
  if (normalized.some(file => !file || file.startsWith('/') || file.split('/').includes('..'))) return 'ineligible';

  const docsOnly = normalized.every(file => file.startsWith('docs/') || DOCS_FILE_ALLOWLIST.test(file));
  if (docsOnly) return 'docs';

  const dependenciesOnly = normalized.every(file => !file.includes('/') && DEPENDENCY_FILE_ALLOWLIST.has(file));
  if (dependenciesOnly) return 'dependency-patch';
  return 'ineligible';
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function promptDigests(): Record<string, string> {
  return Object.fromEntries(readdirSync(PROMPTS_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => [entry.name, sha256(readFileSync(join(PROMPTS_DIR, entry.name)))] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
}

/** 모델, 프롬프트, 검증 정책, 분류 규칙이 같을 때만 eval/live 성공 기록을 합산한다. */
export function autoMergePolicyFingerprint(
  config: Pick<ProjectConfig, 'verify' | 'roleBoundary' | 'runtime'> | undefined,
  models: Record<string, string>,
  runtimeModelSettings: { effort?: string; fallbackModel?: string } = {},
): string {
  return sha256(stableJson({
    version: AUTO_MERGE_POLICY_VERSION,
    agentPolicy: AGENT_SPECS,
    models,
    runtimeModelSettings,
    prompts: promptDigests(),
    verify: config?.verify ?? null,
    roleBoundary: config?.roleBoundary ?? null,
    runtime: config?.runtime ?? null,
  }));
}

export interface AutoMergeEvalResult {
  caseId: string;
  category?: AutoMergeRiskCategory;
  policyFingerprint?: string;
  pass: boolean;
  skipped?: boolean;
  evaluatedAt?: string;
}

export interface AutoMergeEvalArtifact {
  schemaVersion?: number;
  finishedAt?: string;
  results?: AutoMergeEvalResult[];
}

export interface EvalTrustStreak {
  passedCount: number;
  distinctCaseCount: number;
  requiredCount: number;
  requiredDistinctCases: number;
  qualifies: boolean;
  reason: string;
}

function deniedEvalStreak(reason: string): EvalTrustStreak {
  return {
    passedCount: 0,
    distinctCaseCount: 0,
    requiredCount: AUTO_MERGE_EVAL_STREAK_MIN,
    requiredDistinctCases: AUTO_MERGE_EVAL_CASE_MIN,
    qualifies: false,
    reason,
  };
}

/** data/evals의 성공 결과에서 현재 정책 fingerprint에만 해당하는 연속 streak를 계산한다. */
export function calculateEvalTrustStreak(
  artifacts: AutoMergeEvalArtifact[],
  category: AutoMergeRiskCategory,
  fingerprint: string,
): EvalTrustStreak {
  const evaluations = artifacts.flatMap((artifact, artifactIndex) =>
    (artifact.results ?? []).map((result, resultIndex) => ({
      result,
      at: result.evaluatedAt ?? artifact.finishedAt ?? '',
      tieBreak: `${artifactIndex.toString().padStart(8, '0')}:${resultIndex.toString().padStart(8, '0')}`,
    })))
    .filter(({ result }) => result.category === category)
    .sort((left, right) => left.at.localeCompare(right.at) || left.tieBreak.localeCompare(right.tieBreak));

  let streak: AutoMergeEvalResult[] = [];
  for (const { result } of evaluations) {
    if (result.policyFingerprint !== fingerprint || result.skipped || !result.pass) {
      streak = [];
      continue;
    }
    streak.push(result);
  }

  const passedCount = streak.length;
  const distinctCaseCount = new Set(streak.map(result => result.caseId)).size;
  const qualifies = passedCount >= AUTO_MERGE_EVAL_STREAK_MIN && distinctCaseCount >= AUTO_MERGE_EVAL_CASE_MIN;
  const reason = qualifies
    ? `Eval streak qualifies (${passedCount} consecutive passes across ${distinctCaseCount} cases).`
    : `Eval trust requires ${AUTO_MERGE_EVAL_STREAK_MIN} consecutive passes across ${AUTO_MERGE_EVAL_CASE_MIN} distinct cases; found ${passedCount} passes across ${distinctCaseCount} cases.`;
  return {
    passedCount,
    distinctCaseCount,
    requiredCount: AUTO_MERGE_EVAL_STREAK_MIN,
    requiredDistinctCases: AUTO_MERGE_EVAL_CASE_MIN,
    qualifies,
    reason,
  };
}

/** 손상된 이력은 무시하지 않고 자동 머지 자격을 거부한다. */
export function loadEvalTrustStreak(
  dataDir: string,
  category: AutoMergeRiskCategory,
  fingerprint: string,
): EvalTrustStreak {
  let files: string[];
  try {
    files = readdirSync(dataDir).filter(name => /^\d{4}-\d{2}-\d{2}T.*\.json$/.test(name)).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return calculateEvalTrustStreak([], category, fingerprint);
    return deniedEvalStreak(`Could not read eval history: ${err instanceof Error ? err.message : String(err)}`);
  }
  const artifacts: AutoMergeEvalArtifact[] = [];
  for (const file of files) {
    try {
      const artifact = JSON.parse(readFileSync(join(dataDir, file), 'utf-8')) as AutoMergeEvalArtifact;
      if (artifact && typeof artifact === 'object' && Array.isArray(artifact.results)) artifacts.push(artifact);
    } catch (err) {
      return deniedEvalStreak(`Eval history is unreadable (${file}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return calculateEvalTrustStreak(artifacts, category, fingerprint);
}
