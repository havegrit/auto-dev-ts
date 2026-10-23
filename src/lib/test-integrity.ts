import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { globToRegExp, matchesAnyGlob, snapshotWorkspace, workspaceHeadSha, type WorkspaceSnapshot } from './role-boundary.js';
import type { VerifyConfig } from './project-config.js';

const execFileAsync = promisify(execFile);

export const BUILTIN_PROTECTED_GLOBS = [
  '.auto-dev/project.json',
  '.auto-dev/checks/**',
  '.auto-dev/rules.json',
];

export const DEFAULT_TEST_GLOBS = [
  '**/tests/**',
  '**/src/test/**',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*Test.java',
  '**/*Tests.java',
  '**/test_*.py',
  '**/*_test.py',
];

export const TEST_WEAKENING_MARKERS = [
  /\.skip\s*\(/g,
  /\bxit\s*\(/g,
  /\bxdescribe\s*\(/g,
  /\.only\s*\(/g,
  /@Disabled/g,
  /@Ignore/g,
  /pytest\.mark\.(?:skip|xfail)/g,
  /assumeTrue\(\s*false/g,
  /return;\s*\/\/\s*TODO/g,
];

export const WORKSPACE_DELETED = '<deleted>';

export interface JUnitCounts {
  tests: number;
  skipped: number;
  failures: number;
  errors: number;
}

export interface TestIntegrityBaseline {
  startHeadSha: string;
  workspaceSnapshot: Record<string, string>;
  dirtyTestPaths: string[];
  trackedTestPaths: string[];
  junitCounts?: JUnitCounts;
}

export interface JUnitReportResult {
  counts?: JUnitCounts;
  stalePaths: string[];
}

export function junitRegressionReasons(baseline: JUnitCounts, current: JUnitCounts): string[] {
  const reasons: string[] = [];
  if (current.tests < baseline.tests) reasons.push(`test count decreased (${baseline.tests} → ${current.tests})`);
  if (current.skipped > baseline.skipped) reasons.push(`skipped count increased (${baseline.skipped} → ${current.skipped})`);
  if (current.failures > 0) reasons.push(`JUnit reports ${current.failures} failure(s)`);
  if (current.errors > 0) reasons.push(`JUnit reports ${current.errors} error(s)`);
  return reasons;
}

export function effectiveTestGlobs(configured: string[] = []): string[] {
  return [...new Set([...DEFAULT_TEST_GLOBS, ...configured])];
}

function snapshotRecord(snapshot: WorkspaceSnapshot): Record<string, string> {
  return Object.fromEntries(snapshot);
}

export async function captureTestIntegrityBaseline(
  projectDir: string,
  testGlobs: string[],
  protectedGlobs: string[],
): Promise<TestIntegrityBaseline> {
  let tracked: Awaited<ReturnType<typeof execFileAsync>>;
  try {
    tracked = await execFileAsync('git', ['-C', projectDir, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    throw new Error('integrity_unavailable: a Git worktree and readable HEAD are required');
  }
  const trackedPaths = typeof tracked.stdout === 'string' ? tracked.stdout : tracked.stdout.toString('utf8');
  const [snapshot, startHeadSha] = await Promise.all([
    snapshotWorkspace(projectDir, [...testGlobs, ...protectedGlobs]),
    workspaceHeadSha(projectDir),
  ]);
  if (!snapshot || !startHeadSha) throw new Error('integrity_unavailable: a Git worktree and readable HEAD are required');
  const trackedTestPaths = trackedPaths.split('\0').filter(Boolean).filter(path => matchesAnyGlob(path, testGlobs));
  const dirtyTestPaths = [...snapshot.keys()].filter(path => matchesAnyGlob(path, testGlobs)).sort();
  return {
    startHeadSha,
    workspaceSnapshot: snapshotRecord(snapshot),
    dirtyTestPaths,
    trackedTestPaths,
  };
}

function changedPaths(before: Record<string, string>, after: WorkspaceSnapshot): string[] {
  const changed = new Set<string>();
  for (const [path, hash] of after) if (before[path] !== hash) changed.add(path);
  for (const path of Object.keys(before)) if (!after.has(path)) changed.add(path);
  return [...changed].sort();
}

export async function findProtectedPathChanges(
  projectDir: string,
  baseline: TestIntegrityBaseline,
  protectedGlobs: string[],
): Promise<string[]> {
  const after = await snapshotWorkspace(projectDir, protectedGlobs);
  if (!after) throw new Error('integrity_unavailable: could not snapshot protected paths');
  return changedPaths(baseline.workspaceSnapshot, after).filter(path => matchesAnyGlob(path, protectedGlobs));
}

function markerCounts(content: string): number[] {
  return TEST_WEAKENING_MARKERS.map((marker) => {
    const expression = new RegExp(marker.source, marker.flags);
    return [...content.matchAll(expression)].length;
  });
}

function hasNewWeakeningMarker(before: string, after: string): boolean {
  const oldCounts = markerCounts(before);
  const newCounts = markerCounts(after);
  return newCounts.some((count, index) => count > oldCounts[index]);
}

async function gitPaths(projectDir: string, args: string[]): Promise<string[]> {
  const result = await execFileAsync('git', ['-C', projectDir, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.split('\0').filter(Boolean);
}

async function committedFile(projectDir: string, sha: string, path: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', ['-C', projectDir, 'show', `${sha}:${path}`], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout;
  } catch {
    return undefined;
  }
}

/** 시작 커밋 대비 skip/focus 증가·기존 테스트 삭제와 단계 내 신규 테스트 삭제를 찾는다. */
export async function findTestIntegrityViolations(
  projectDir: string,
  baseline: TestIntegrityBaseline,
  testGlobs: string[],
  beforeStep?: Record<string, string>,
  afterStep?: WorkspaceSnapshot,
): Promise<string[]> {
  const dirtyAtStart = new Set(baseline.dirtyTestPaths);
  const trackedAtStart = new Set(baseline.trackedTestPaths);
  const violations = new Set<string>();
  const deleted = await gitPaths(projectDir, ['diff', '--name-only', '--diff-filter=D', '-z', baseline.startHeadSha, '--']);
  for (const path of deleted) {
    if (!dirtyAtStart.has(path) && matchesAnyGlob(path, testGlobs)) violations.add(path);
  }

  const changed = await gitPaths(projectDir, ['diff', '--name-only', '-z', baseline.startHeadSha, '--']);
  for (const path of changed) {
    if (dirtyAtStart.has(path) || !matchesAnyGlob(path, testGlobs)) continue;
    if (deleted.includes(path)) continue;
    const before = await committedFile(projectDir, baseline.startHeadSha, path);
    let after: string | undefined;
    try { after = await readFile(join(projectDir, path), 'utf8'); } catch { /* 삭제는 위 diff에서 검출 */ }
    if (before !== undefined && after !== undefined && hasNewWeakeningMarker(before, after)) violations.add(path);
  }

  const current = afterStep ?? await snapshotWorkspace(projectDir, testGlobs);
  if (!current) throw new Error('integrity_unavailable: could not snapshot test paths');
  for (const [path, hash] of current) {
    if (dirtyAtStart.has(path) || !matchesAnyGlob(path, testGlobs) || trackedAtStart.has(path) || hash === WORKSPACE_DELETED) continue;
    let content: string;
    try { content = await readFile(join(projectDir, path), 'utf8'); } catch { continue; }
    if (markerCounts(content).some(count => count > 0)) violations.add(path);
  }

  if (beforeStep) {
    const after = afterStep ?? current;
    for (const path of Object.keys(beforeStep)) {
      if (dirtyAtStart.has(path) || !matchesAnyGlob(path, testGlobs)) continue;
      if (!after.has(path) || after.get(path) === WORKSPACE_DELETED) violations.add(path);
    }
    for (const [path, hash] of after) {
      if (!dirtyAtStart.has(path) && matchesAnyGlob(path, testGlobs) && hash === WORKSPACE_DELETED) violations.add(path);
    }
  }
  return [...violations].sort();
}

function parseJUnitXml(content: string): JUnitCounts {
  const suites = [...content.matchAll(/<testsuite\b([^>]*)>/g)];
  if (suites.length === 0) throw new Error('JUnit XML contains no testsuite elements');
  const counts: JUnitCounts = { tests: 0, skipped: 0, failures: 0, errors: 0 };
  for (const suite of suites) {
    const attributes = suite[1];
    for (const key of Object.keys(counts) as Array<keyof JUnitCounts>) {
      const match = attributes.match(new RegExp(`\\b${key}\\s*=\\s*["'](\\d+)["']`));
      if (!match) throw new Error(`JUnit testsuite is missing numeric ${key} attribute`);
      counts[key] += Number(match[1]);
    }
  }
  return counts;
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isFile()) files.push(path);
      else if (entry.isDirectory()) await visit(path);
    }
  };
  const info = await stat(root).catch(() => undefined);
  if (info?.isFile()) return [root];
  if (info?.isDirectory()) await visit(root);
  return files;
}

async function filesForReportGlob(projectDir: string, pattern: string): Promise<string[]> {
  const parts = pattern.split('/');
  const firstWildcard = parts.findIndex(part => /[*?]/.test(part));
  const prefixParts = firstWildcard < 0 ? parts.slice(0, -1) : parts.slice(0, firstWildcard);
  const root = resolve(projectDir, ...prefixParts);
  const files = await walkFiles(root);
  const matcher = globToRegExp(pattern);
  return files.filter(file => matcher.test(relative(projectDir, file).split(/[\\/]/).join('/')));
}

/** 설정된 JUnit 리포트를 읽는다. 오래된 파일은 호출부가 경고 후 비교를 생략한다. */
export async function readJUnitReport(
  projectDir: string,
  config: NonNullable<VerifyConfig['report']>,
  verifyStartedAt: number,
): Promise<JUnitReportResult> {
  const matched = new Set<string>();
  for (const pattern of config.paths) {
    for (const file of await filesForReportGlob(projectDir, pattern)) matched.add(file);
  }
  const files = [...matched].sort();
  if (files.length === 0) throw new Error('No JUnit XML report files matched verify.report.paths');
  const stalePaths: string[] = [];
  const documents: string[] = [];
  for (const file of files) {
    const info = await stat(file);
    if (info.mtimeMs < verifyStartedAt) stalePaths.push(relative(projectDir, file));
    documents.push(await readFile(file, 'utf8'));
  }
  if (stalePaths.length > 0) return { stalePaths };
  const counts: JUnitCounts = { tests: 0, skipped: 0, failures: 0, errors: 0 };
  for (const document of documents) {
    const parsed = parseJUnitXml(document);
    for (const key of Object.keys(counts) as Array<keyof JUnitCounts>) counts[key] += parsed[key];
  }
  return { counts, stalePaths: [] };
}
