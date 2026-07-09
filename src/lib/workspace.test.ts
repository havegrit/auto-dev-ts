import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

describe('listProjects', () => {
  let root: string;
  const orig = process.env.AUTO_DEV_WORKSPACE_ROOT;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ws-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (orig === undefined) delete process.env.AUTO_DEV_WORKSPACE_ROOT;
    else process.env.AUTO_DEV_WORKSPACE_ROOT = orig;
    vi.resetModules();
  });

  // WORKSPACE_ROOT is captured at import time, so re-import after setting the env.
  async function load(r: string) {
    process.env.AUTO_DEV_WORKSPACE_ROOT = r;
    vi.resetModules();
    return (await import('./workspace.js')).listProjects;
  }

  it('lists directories first, then files, hiding junk/dot/underscore entries', async () => {
    mkdirSync(join(root, 'beta-app'));
    mkdirSync(join(root, 'alpha-app'));
    mkdirSync(join(root, '__MACOSX'));
    mkdirSync(join(root, '_backup'));
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'README.md'), '');
    writeFileSync(join(root, 'package.json'), '');

    const listProjects = await load(root);
    // dirs sorted, then files sorted ('R' < 'p' in code-unit order)
    expect(listProjects()).toEqual(['alpha-app', 'beta-app', 'README.md', 'package.json']);
  });

  it('returns [] when the root does not exist', async () => {
    const listProjects = await load(join(root, 'does-not-exist'));
    expect(listProjects()).toEqual([]);
  });
});

describe('resolveProjectDir', () => {
  const orig = process.env.AUTO_DEV_WORKSPACE_ROOT;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ws-resolve-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    if (orig === undefined) delete process.env.AUTO_DEV_WORKSPACE_ROOT;
    else process.env.AUTO_DEV_WORKSPACE_ROOT = orig;
    vi.resetModules();
  });

  async function load(r: string) {
    process.env.AUTO_DEV_WORKSPACE_ROOT = r;
    vi.resetModules();
    return (await import('./workspace.js')).resolveProjectDir;
  }

  it('expands a leading ~ in the workspace root to the home directory', async () => {
    const resolveProjectDir = await load('~/workspace');
    expect(resolveProjectDir()).toBe(join(homedir(), 'workspace'));
    expect(resolveProjectDir('docs')).toBe(join(homedir(), 'workspace', 'docs'));
  });

  it('treats a bare ~ as the home directory', async () => {
    const resolveProjectDir = await load('~');
    expect(resolveProjectDir()).toBe(homedir());
  });

  it('rejects absolute, tilde-prefixed, and escaping project paths', async () => {
    const resolveProjectDir = await load(root);
    expect(() => resolveProjectDir('/tmp/project')).toThrow('Invalid project name');
    expect(() => resolveProjectDir('~/workspace')).toThrow('Invalid project name');
    expect(() => resolveProjectDir('../outside')).toThrow('Invalid project name');
  });

  it('resolves a normal relative project name under the workspace root', async () => {
    const resolveProjectDir = await load('/home/shin/workspace');
    expect(resolveProjectDir('wealth-os')).toBe('/home/shin/workspace/wealth-os');
  });

  it('creates a new project path from the seed when no project name is provided', async () => {
    const resolveProjectDir = await load(root);
    expect(resolveProjectDir(undefined, '# My New App\nBuild this')).toBe(join(root, 'my-new-app'));
  });
});
