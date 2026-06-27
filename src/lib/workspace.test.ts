import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
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
