import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readWorkflowEvidence, writeWorkflowEvidence } from './evidence.js';

let root: string;

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('workflow evidence storage', () => {
  it('stores and reads runtime observations by workflow id', async () => {
    root = mkdtempSync(`${tmpdir()}/autodev-evidence-test-`);
    const records = [{
      stage: 'healthcheck',
      status: 'PASS' as const,
      timestamp: new Date().toISOString(),
      request: { method: 'GET', url: 'http://localhost/health' },
      response: { status: 200, ok: true, bodyTail: 'ready' },
    }];

    await writeWorkflowEvidence('workflow-1', records, root);
    await writeWorkflowEvidence('workflow-1', [{
      stage: 'runtime-down', status: 'PASS', timestamp: new Date().toISOString(), command: 'down', exitCode: 0,
    }], root);

    await expect(readWorkflowEvidence('workflow-1', root)).resolves.toEqual({
      version: 1,
      workflowRunId: 'workflow-1',
      records: [...records, expect.objectContaining({ stage: 'runtime-down' })],
    });
  });

  it('returns undefined before evidence is written', async () => {
    root = mkdtempSync(`${tmpdir()}/autodev-evidence-test-`);
    await expect(readWorkflowEvidence('workflow-1', root)).resolves.toBeUndefined();
  });

  it('rejects unsafe workflow ids', async () => {
    root = mkdtempSync(`${tmpdir()}/autodev-evidence-test-`);
    await expect(readWorkflowEvidence('../outside', root)).rejects.toThrow('Invalid workflow run id');
  });
});
