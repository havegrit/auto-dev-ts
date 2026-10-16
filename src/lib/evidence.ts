import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface EvidenceRecord {
  stage: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIPPED';
  timestamp: string;
  durationMs?: number;
  command?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  cancelled?: boolean;
  outputTail?: string;
  request?: { method: string; url: string };
  response?: { status?: number; ok?: boolean; bodyTail?: string; error?: string };
  report?: string;
  verifierRunId?: string;
  changedFiles?: string[];
}

export interface WorkflowEvidence {
  version: 1;
  workflowRunId: string;
  records: EvidenceRecord[];
}

function evidenceFile(root: string, workflowRunId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(workflowRunId)) throw new Error('Invalid workflow run id');
  const directory = resolve(root, workflowRunId);
  if (!directory.startsWith(`${resolve(root)}/`)) throw new Error('Evidence path escaped its root');
  return join(directory, 'evidence.json');
}

export function defaultEvidenceRoot(): string {
  return join(process.cwd(), 'data', 'evidence');
}

export async function writeWorkflowEvidence(
  workflowRunId: string,
  records: EvidenceRecord[],
  root = defaultEvidenceRoot(),
): Promise<void> {
  const file = evidenceFile(root, workflowRunId);
  const directory = resolve(file, '..');
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.evidence-${randomUUID()}.tmp`);
  const previous = await readWorkflowEvidence(workflowRunId, root);
  const data: WorkflowEvidence = { version: 1, workflowRunId, records: [...(previous?.records ?? []), ...records] };
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function readWorkflowEvidence(
  workflowRunId: string,
  root = defaultEvidenceRoot(),
): Promise<WorkflowEvidence | undefined> {
  let raw: string;
  try { raw = await readFile(evidenceFile(root, workflowRunId), 'utf-8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const value = JSON.parse(raw) as WorkflowEvidence;
  if (value.version !== 1 || value.workflowRunId !== workflowRunId || !Array.isArray(value.records)) {
    throw new Error(`Invalid evidence file for workflow ${workflowRunId}`);
  }
  return value;
}
