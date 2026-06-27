import { describe, expect, it } from 'vitest';
import { extractJsonObject, normalizeCodexResult } from './output.js';

describe('codex output parsing', () => {
  it('extracts the final JSON object from prose or fenced output', () => {
    const raw = [
      '작업을 마쳤습니다.',
      '```json',
      '{"status":"success","summary":"ok","changedFiles":["src/a.ts"],"tests":{"command":"npm test","result":"passed"},"notes":[]}',
      '```',
    ].join('\n');

    expect(extractJsonObject(raw)).toEqual({
      status: 'success',
      summary: 'ok',
      changedFiles: ['src/a.ts'],
      tests: { command: 'npm test', result: 'passed' },
      notes: [],
    });
  });

  it('falls back to raw output when JSON cannot be parsed', () => {
    const result = normalizeCodexResult({
      exitCode: 0,
      stdout: 'plain text result',
      stderr: '',
      gitChangedFiles: ['src/fallback.ts'],
    });

    expect(result).toMatchObject({
      status: 'success',
      output: 'plain text result',
      changedFiles: ['src/fallback.ts'],
      stopReason: 'codex_cli_exit_0',
    });
  });

  it('marks non-zero exits as errors and preserves stderr', () => {
    const result = normalizeCodexResult({
      exitCode: 2,
      stdout: 'partial',
      stderr: 'not logged in',
      gitChangedFiles: [],
    });

    expect(result).toMatchObject({
      status: 'error',
      errorType: 'codex_auth_failed',
      output: 'partial\n\nstderr:\nnot logged in',
      errors: ['not logged in'],
    });
  });
});
