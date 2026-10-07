import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { snapshotWorkspace, findRoleBoundaryViolations, matchesAnyGlob } from './role-boundary.js';

let dir: string;

function git(...args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}

function write(path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const BOUNDARY = { testGlobs: ['src/test/**', '**/*.test.ts'], ignoreGlobs: [] };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autodev-boundary-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('matchesAnyGlob', () => {
  it.each([
    ['src/test/FooTest.java', ['src/test/**'], true],
    ['src/main/Foo.java', ['src/test/**'], false],
    ['a.test.ts', ['**/*.test.ts'], true],
    ['src/lib/a.test.ts', ['**/*.test.ts'], true],
    ['src/lib/a.ts', ['**/*.test.ts'], false],
    ['build/classes/Foo.class', ['build/**'], true],
  ])('matches %s against %j as %s', (path, globs, expected) => {
    expect(matchesAnyGlob(path as string, globs as string[])).toBe(expected);
  });

  it('does not let * cross a path separator', () => {
    expect(matchesAnyGlob('src/lib/a.ts', ['src/*.ts'])).toBe(false);
  });
});

describe('snapshotWorkspace', () => {
  it('returns undefined outside a git repository so the caller can skip the check', async () => {
    expect(await snapshotWorkspace(dir)).toBeUndefined();
  });

  it('hashes changed and untracked files, excluding gitignored build output', async () => {
    git('init', '-q');
    write('.gitignore', 'build/\n');
    write('src/main/Foo.java', 'original');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');

    write('src/main/Foo.java', 'changed');
    write('src/test/FooTest.java', 'new test');
    write('build/Foo.class', 'generated');

    const snapshot = await snapshotWorkspace(dir);

    expect([...snapshot!.keys()].sort()).toEqual(['src/main/Foo.java', 'src/test/FooTest.java']);
  });
});

describe('findRoleBoundaryViolations', () => {
  it('reports a production file whose content changed during the step', async () => {
    git('init', '-q');
    write('src/main/Foo.java', 'scaffold output');
    write('src/test/FooTest.java', 'test v1');
    const before = (await snapshotWorkspace(dir))!;

    write('src/main/Foo.java', 'test agent edited this');
    write('src/test/FooTest.java', 'test v2');
    const after = (await snapshotWorkspace(dir))!;

    expect(findRoleBoundaryViolations(before, after, BOUNDARY)).toEqual(['src/main/Foo.java']);
  });

  it('allows new and edited test files', async () => {
    git('init', '-q');
    write('src/main/Foo.java', 'scaffold output');
    const before = (await snapshotWorkspace(dir))!;

    write('src/test/FooTest.java', 'brand new');
    write('src/lib/helper.test.ts', 'brand new');
    const after = (await snapshotWorkspace(dir))!;

    expect(findRoleBoundaryViolations(before, after, BOUNDARY)).toEqual([]);
  });

  it('treats a reverted production file as a violation', async () => {
    git('init', '-q');
    write('src/main/Foo.java', 'scaffold output');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    write('src/main/Foo.java', 'scaffold edit');
    const before = (await snapshotWorkspace(dir))!;

    write('src/main/Foo.java', 'scaffold output');
    const after = (await snapshotWorkspace(dir))!;

    expect(findRoleBoundaryViolations(before, after, BOUNDARY)).toEqual(['src/main/Foo.java']);
  });

  it('suppresses false positives listed in ignoreGlobs', async () => {
    git('init', '-q');
    const before = (await snapshotWorkspace(dir))!;

    write('coverage/report.json', '{}');
    const after = (await snapshotWorkspace(dir))!;

    expect(findRoleBoundaryViolations(before, after, BOUNDARY)).toEqual(['coverage/report.json']);
    expect(findRoleBoundaryViolations(before, after, { ...BOUNDARY, ignoreGlobs: ['coverage/**'] })).toEqual([]);
  });
});
