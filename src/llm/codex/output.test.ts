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

  it('renders a successful JSON contract as readable markdown sections (not raw JSON)', () => {
    const result = normalizeCodexResult({
      exitCode: 0,
      stdout: '{"status":"success","summary":"기능 추가 완료","changedFiles":["src/a.ts"],"tests":{"command":"npm test","result":"passed"},"notes":["후속 리팩터 필요"]}',
      stderr: '',
      gitChangedFiles: ['src/b.ts'],
      tokensIn: 1200,
      tokensOut: 340,
    });

    expect(result.status).toBe('success');
    expect(result.output).not.toContain('"status"');
    expect(result.output).toContain('기능 추가 완료');
    expect(result.output).toContain('**변경된 파일**');
    expect(result.output).toContain('`src/a.ts`');
    expect(result.output).toContain('`src/b.ts`');
    expect(result.output).toContain('**테스트**: `npm test` → passed');
    expect(result.output).toContain('후속 리팩터 필요');
    expect(result).toMatchObject({ tokensIn: 1200, tokensOut: 340 });
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

  it('marks permission-blocked successful contracts as errors', () => {
    const result = normalizeCodexResult({
      exitCode: 0,
      stdout: JSON.stringify({
        status: 'success',
        summary: '샌드박스가 read-only라 파일 생성이 불가능했습니다.',
        changedFiles: [],
        tests: { command: 'not run', result: 'blocked' },
        notes: ['쓰기 권한이 필요합니다.'],
      }),
      stderr: 'Reading additional input from stdin...',
      gitChangedFiles: [],
    });

    expect(result).toMatchObject({
      status: 'error',
      errorType: 'codex_permission_blocked',
    });
    expect(result.output).toContain('read-only');
  });
});
