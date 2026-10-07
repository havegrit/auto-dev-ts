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

  it('ignores unknown fields so later phases can extend the schema', () => {
    writeConfig(JSON.stringify({
      version: 1,
      verify: { command: 'npm test' },
      runtime: { up: 'docker compose up -d' },
    }));

    const config = loadProjectConfig(dir);

    expect(config?.verify?.command).toBe('npm test');
    expect(config).not.toHaveProperty('runtime');
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
