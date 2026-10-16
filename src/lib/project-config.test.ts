import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadProjectConfig,
  roleBoundaryEnabled,
  ProjectConfigError,
  DEFAULT_VERIFY_TIMEOUT_MS,
} from './project-config.js';

let dir: string;

function writeConfig(content: string): void {
  mkdirSync(join(dir, '.auto-dev'), { recursive: true });
  writeFileSync(join(dir, '.auto-dev/project.json'), content);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autodev-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadProjectConfig', () => {
  it('reads verify and roleBoundary from a valid config', () => {
    writeConfig(JSON.stringify({
      version: 1,
      verify: { command: './gradlew check', timeoutMs: 60000 },
      roleBoundary: { testGlobs: ['src/test/**'], ignoreGlobs: ['build/**'] },
    }));

    const config = loadProjectConfig(dir);

    expect(config).toEqual({
      version: 1,
      verify: { command: './gradlew check', timeoutMs: 60000 },
      roleBoundary: { testGlobs: ['src/test/**'], ignoreGlobs: ['build/**'] },
    });
  });

  it('returns undefined when the project has no config file', () => {
    expect(loadProjectConfig(dir)).toBeUndefined();
  });

  it('applies the default verify timeout when it is omitted', () => {
    writeConfig(JSON.stringify({ version: 1, verify: { command: 'npm test' } }));

    expect(loadProjectConfig(dir)?.verify?.timeoutMs).toBe(DEFAULT_VERIFY_TIMEOUT_MS);
  });

  it('parses a runtime verification config', () => {
    writeConfig(JSON.stringify({
      version: 1,
      verify: { command: 'npm test' },
      runtime: {
        up: 'docker compose up -d --wait',
        down: 'docker compose down -v',
        healthcheck: { url: 'http://localhost:8080/health', timeoutMs: 30000 },
        checks: ['.auto-dev/checks/smoke.sh'],
      },
    }));

    const config = loadProjectConfig(dir);

    expect(config?.verify?.command).toBe('npm test');
    expect(config?.runtime).toEqual({
      up: 'docker compose up -d --wait',
      down: 'docker compose down -v',
      healthcheck: { url: 'http://localhost:8080/health', timeoutMs: 30000 },
      checks: ['.auto-dev/checks/smoke.sh'],
    });
  });

  it('reads workflow restart recovery only when explicitly enabled', () => {
    writeConfig(JSON.stringify({ version: 1, workflow: { resumeOnRestart: true } }));
    expect(loadProjectConfig(dir)?.workflow).toEqual({ resumeOnRestart: true });
  });

  it('rejects a non-boolean workflow restart setting', () => {
    writeConfig(JSON.stringify({ version: 1, workflow: { resumeOnRestart: 'yes' } }));
    expect(() => loadProjectConfig(dir)).toThrow(/workflow\.resumeOnRestart must be a boolean/);
  });

  it('parses PR delivery and optional base branch', () => {
    writeConfig(JSON.stringify({ version: 1, delivery: { mode: 'pull-request', baseBranch: 'release/next' } }));
    expect(loadProjectConfig(dir)?.delivery).toEqual({ mode: 'pull-request', baseBranch: 'release/next' });
  });

  it('keeps automatic merge disabled unless explicitly enabled for dry-run evaluation', () => {
    writeConfig(JSON.stringify({ version: 1, delivery: { mode: 'pull-request', autoMerge: { enabled: true } } }));
    expect(loadProjectConfig(dir)?.delivery?.autoMerge).toEqual({ enabled: true });
    writeConfig(JSON.stringify({ version: 1, delivery: { mode: 'pull-request', autoMerge: {} } }));
    expect(loadProjectConfig(dir)?.delivery?.autoMerge).toEqual({ enabled: false });
    writeConfig(JSON.stringify({ version: 1, delivery: { mode: 'pull-request', autoMerge: { enabled: 'yes' } } }));
    expect(() => loadProjectConfig(dir)).toThrow(/delivery\.autoMerge\.enabled must be a boolean/);
    writeConfig(JSON.stringify({ version: 1, delivery: { mode: 'local', autoMerge: { enabled: true } } }));
    expect(() => loadProjectConfig(dir)).toThrow(/requires delivery\.mode=pull-request/);
  });

  it('defaults an omitted delivery mode to local and rejects unsupported modes', () => {
    writeConfig(JSON.stringify({ version: 1, delivery: {} }));
    expect(loadProjectConfig(dir)?.delivery).toEqual({ mode: 'local' });
    writeConfig(JSON.stringify({ version: 1, delivery: { mode: 'merge' } }));
    expect(() => loadProjectConfig(dir)).toThrow(/delivery\.mode must be local or pull-request/);
    writeConfig(JSON.stringify({ version: 1, delivery: { mode: null } }));
    expect(() => loadProjectConfig(dir)).toThrow(/delivery\.mode must be local or pull-request/);
  });

  it('applies the runtime healthcheck timeout default and ignores future top-level fields', () => {
    writeConfig(JSON.stringify({
      version: 1,
      runtime: {
        up: 'docker compose up -d',
        down: 'docker compose down',
        healthcheck: { url: 'https://localhost/health' },
        checks: [],
      },
      future: { flag: true },
    }));

    expect(loadProjectConfig(dir)?.runtime?.healthcheck.timeoutMs).toBe(120_000);
  });

  it.each([
    ['missing down command', { up: 'up', healthcheck: { url: 'http://localhost' }, checks: [] }, /runtime\.down/],
    ['invalid healthcheck URL', { up: 'up', down: 'down', healthcheck: { url: 'file:///tmp/x' }, checks: [] }, /runtime\.healthcheck\.url/],
    ['invalid healthcheck timeout', { up: 'up', down: 'down', healthcheck: { url: 'http://localhost', timeoutMs: 0 }, checks: [] }, /runtime\.healthcheck\.timeoutMs/],
    ['invalid checks list', { up: 'up', down: 'down', healthcheck: { url: 'http://localhost' }, checks: [4] }, /runtime\.checks/],
    ['check path traversal', { up: 'up', down: 'down', healthcheck: { url: 'http://localhost' }, checks: ['../outside.sh'] }, /stay inside/],
    ['check glob instead of script path', { up: 'up', down: 'down', healthcheck: { url: 'http://localhost' }, checks: ['checks/*.sh'] }, /stay inside/],
  ])('rejects %s', (_label, runtime, pattern) => {
    writeConfig(JSON.stringify({ version: 1, runtime }));

    expect(() => loadProjectConfig(dir)).toThrow(pattern as RegExp);
  });

  it('fails loudly with the config path when the JSON is malformed', () => {
    writeConfig('{ not json');

    expect(() => loadProjectConfig(dir)).toThrow(ProjectConfigError);
    expect(() => loadProjectConfig(dir)).toThrow(/\.auto-dev\/project\.json/);
  });

  it.each([
    ['unsupported version', { version: 2, verify: { command: 'npm test' } }, /version must be 1/],
    ['empty verify command', { version: 1, verify: { command: '  ' } }, /verify\.command/],
    ['non-positive timeout', { version: 1, verify: { command: 'npm test', timeoutMs: 0 } }, /verify\.timeoutMs/],
    ['non-string glob', { version: 1, roleBoundary: { testGlobs: [42] } }, /roleBoundary\.testGlobs/],
  ])('rejects %s instead of silently ignoring it', (_label, body, pattern) => {
    writeConfig(JSON.stringify(body));

    expect(() => loadProjectConfig(dir)).toThrow(pattern as RegExp);
  });
});

describe('roleBoundaryEnabled', () => {
  it('is disabled without config or without testGlobs', () => {
    expect(roleBoundaryEnabled(undefined)).toBe(false);
    expect(roleBoundaryEnabled({ version: 1 })).toBe(false);
    expect(roleBoundaryEnabled({ version: 1, roleBoundary: { testGlobs: [], ignoreGlobs: [] } })).toBe(false);
  });

  it('is enabled once test paths are declared', () => {
    expect(roleBoundaryEnabled({ version: 1, roleBoundary: { testGlobs: ['tests/**'], ignoreGlobs: [] } })).toBe(true);
  });
});
