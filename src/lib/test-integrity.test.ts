import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { snapshotWorkspace } from './role-boundary.js';
import {
  BUILTIN_PROTECTED_GLOBS,
  DEFAULT_TEST_GLOBS,
  captureTestIntegrityBaseline,
  effectiveTestGlobs,
  findProtectedPathChanges,
  findTestIntegrityViolations,
  readJUnitReport,
} from './test-integrity.js';

let dir: string;

function git(...args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}

function write(path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function initRepository(): void {
  git('init', '-q');
  write('.gitignore', '.auto-dev/checks/\n');
  write('src/unit.test.ts', "it('works', () => expect(1).toBe(1));\n");
  git('add', '-A');
  git('-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'initial');
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'autodev-integrity-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('test integrity baselines', () => {
  it('uses built-in test globs and adds project-specific globs', () => {
    expect(BUILTIN_PROTECTED_GLOBS).toEqual([
      '.auto-dev/project.json', '.auto-dev/checks/**', '.auto-dev/rules.json',
    ]);
    expect(effectiveTestGlobs(['integration/specs/**'])).toEqual([...DEFAULT_TEST_GLOBS, 'integration/specs/**']);
    expect(effectiveTestGlobs(['**/*.test.*'])).toEqual(DEFAULT_TEST_GLOBS);
  });

  it('requires a git worktree and records dirty test files at workflow start', async () => {
    await expect(captureTestIntegrityBaseline(dir, DEFAULT_TEST_GLOBS, BUILTIN_PROTECTED_GLOBS))
      .rejects.toThrow(/integrity_unavailable/);
    initRepository();
    write('src/unit.test.ts', "it.skip('works', () => {});\n");
    const baseline = await captureTestIntegrityBaseline(dir, ['**/*.test.ts'], BUILTIN_PROTECTED_GLOBS);
    expect(baseline.dirtyTestPaths).toEqual(['src/unit.test.ts']);
  });

  it('finds new skip markers and deleted tracked tests from the start HEAD', async () => {
    initRepository();
    const baseline = await captureTestIntegrityBaseline(dir, ['**/*.test.ts'], BUILTIN_PROTECTED_GLOBS);
    write('src/unit.test.ts', "it.skip('works', () => {});\n");
    expect(await findTestIntegrityViolations(dir, baseline, ['**/*.test.ts'])).toEqual(['src/unit.test.ts']);

    write('src/unit.test.ts', "it('works', () => expect(1).toBe(1));\n");
    unlinkSync(join(dir, 'src/unit.test.ts'));
    expect(await findTestIntegrityViolations(dir, baseline, ['**/*.test.ts'])).toEqual(['src/unit.test.ts']);
  });

  it('detects a newly created test deleted during an agent step', async () => {
    initRepository();
    const baseline = await captureTestIntegrityBaseline(dir, ['**/*.test.ts'], BUILTIN_PROTECTED_GLOBS);
    write('tests/generated.test.ts', "it('new', () => {});\n");
    const before = Object.fromEntries((await snapshotWorkspace(dir, ['**/*.test.ts']))!);
    unlinkSync(join(dir, 'tests/generated.test.ts'));
    const after = (await snapshotWorkspace(dir, ['**/*.test.ts']))!;
    expect(await findTestIntegrityViolations(dir, baseline, ['**/*.test.ts'], before, after))
      .toEqual(['tests/generated.test.ts']);
  });

  it('does not count skip changes in test files already dirty at workflow start', async () => {
    initRepository();
    write('src/unit.test.ts', "it('work in progress', () => {});\n");
    const baseline = await captureTestIntegrityBaseline(dir, ['**/*.test.ts'], BUILTIN_PROTECTED_GLOBS);
    write('src/unit.test.ts', "it.skip('work in progress', () => {});\n");
    expect(await findTestIntegrityViolations(dir, baseline, ['**/*.test.ts'])).toEqual([]);
  });
});

describe('protected paths', () => {
  it('includes ignored guard files in snapshots and reports their changes', async () => {
    initRepository();
    write('.auto-dev/checks/smoke.sh', 'exit 0\n');
    const baseline = await captureTestIntegrityBaseline(dir, ['**/*.test.ts'], BUILTIN_PROTECTED_GLOBS);
    write('.auto-dev/checks/smoke.sh', 'exit 1\n');
    expect(await findProtectedPathChanges(dir, baseline, BUILTIN_PROTECTED_GLOBS))
      .toEqual(['.auto-dev/checks/smoke.sh']);
  });

  it('detects changes to the built-in project config even when no custom protection is declared', async () => {
    initRepository();
    write('.auto-dev/project.json', '{"version":1}\n');
    const baseline = await captureTestIntegrityBaseline(dir, DEFAULT_TEST_GLOBS, BUILTIN_PROTECTED_GLOBS);
    write('.auto-dev/project.json', '{"version":1,"protect":{"globs":[]}}\n');

    expect(await findProtectedPathChanges(dir, baseline, BUILTIN_PROTECTED_GLOBS))
      .toEqual(['.auto-dev/project.json']);
  });
});

describe('readJUnitReport', () => {
  it('sums fresh JUnit suite counts over matching files', async () => {
    const start = Date.now();
    write('reports/a.xml', '<testsuites><testsuite tests="3" skipped="1" failures="0" errors="0" /></testsuites>');
    write('reports/nested/b.xml', '<testsuite tests="2" skipped="0" failures="0" errors="0" />');
    const result = await readJUnitReport(dir, { format: 'junit-xml', paths: ['reports/**/*.xml'] }, start - 1_000);
    expect(result).toEqual({ counts: { tests: 5, skipped: 1, failures: 0, errors: 0 }, stalePaths: [] });
  });

  it('warns about old reports without returning counts', async () => {
    write('reports/old.xml', '<testsuite tests="1" skipped="0" failures="0" errors="0" />');
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'reports/old.xml'), old, old);
    const result = await readJUnitReport(dir, { format: 'junit-xml', paths: ['reports/*.xml'] }, Date.now());
    expect(result.counts).toBeUndefined();
    expect(result.stalePaths).toEqual(['reports/old.xml']);
  });

  it('fails when configured reports are missing or malformed', async () => {
    await expect(readJUnitReport(dir, { format: 'junit-xml', paths: ['missing/*.xml'] }, Date.now()))
      .rejects.toThrow(/No JUnit XML/);
    write('reports/bad.xml', '<testsuite tests="x" />');
    await expect(readJUnitReport(dir, { format: 'junit-xml', paths: ['reports/*.xml'] }, Date.now() - 1_000))
      .rejects.toThrow(/missing numeric tests attribute/);
  });
});
