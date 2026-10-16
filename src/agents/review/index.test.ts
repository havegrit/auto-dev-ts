import { afterEach, describe, expect, it, vi } from 'vitest';

const { captureReviewFindings, projectFindingKey, runNamedAgent } = vi.hoisted(() => ({
  captureReviewFindings: vi.fn(),
  projectFindingKey: vi.fn(() => 'demo'),
  runNamedAgent: vi.fn(async () => ({
    runId: 'review-1', output: 'FINDINGS_JSON: []', tokensIn: 1, tokensOut: 1, durationMs: 5, status: 'DONE' as const,
  })),
}));

vi.mock('../../lib/review-findings.js', () => ({ captureReviewFindings, projectFindingKey }));
vi.mock('../../lib/workspace.js', () => ({ defaultWorkspaceDir: vi.fn(() => '/workspace') }));
vi.mock('../dispatch.js', () => ({ runNamedAgent }));

import { review } from './index.js';

afterEach(() => vi.clearAllMocks());

describe('review findings capture', () => {
  it('captures structured findings for standalone and workflow reviews', async () => {
    const result = await review('inspect', { workflowRunId: 'workflow-1', cwd: '/workspace/demo' });

    expect(result.runId).toBe('review-1');
    expect(runNamedAgent).toHaveBeenCalledWith('review', 'inspect', { workflowRunId: 'workflow-1', cwd: '/workspace/demo' });
    expect(projectFindingKey).toHaveBeenCalledWith('/workspace/demo');
    expect(captureReviewFindings).toHaveBeenCalledWith('FINDINGS_JSON: []', 'review-1', 'workflow-1', 'demo');
  });

  it('uses the review run id when no workflow id exists', async () => {
    await review('inspect', { cwd: '/workspace/demo' });

    expect(captureReviewFindings).toHaveBeenCalledWith('FINDINGS_JSON: []', 'review-1', 'review-1', 'demo');
  });
});
