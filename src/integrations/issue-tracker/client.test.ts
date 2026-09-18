import { beforeEach, describe, expect, it, vi } from 'vitest';

import { httpIssueTracker } from './client.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

describe('httpIssueTracker', () => {
  it('reads the issue-tracker envelope and maps open issues', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      items: [{
        key: 'AD-1',
        title: 'Fix it',
        description: 'details',
        type: 'TASK',
        priority: 'HIGH',
        status: 'OPEN',
        updatedAt: '2026-01-01 00:00:00',
      }],
    }), { status: 200 }));

    const tracker = httpIssueTracker('http://127.0.0.1:8081/');
    await expect(tracker.fetchOpenIssues()).resolves.toEqual([expect.objectContaining({ key: 'AD-1', title: 'Fix it' })]);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8081/issues/?status=OPEN');
  });

  it('creates, claims, heartbeats, patches, lists, and reviews automation jobs', async () => {
    const job = {
      id: 'job_1',
      issueKey: 'AD-1',
      issueTitle: 'Fix it',
      issueStatus: 'IN_PROGRESS',
      sourceRevision: 'abc',
      taskVersion: 1,
      idempotencyKey: 'AD-1:abc:1',
      priority: 'HIGH',
      executionMode: 'AUTO',
      status: 'READY',
      attemptCount: 0,
      createdAt: '2026-01-01 00:00:00',
      updatedAt: '2026-01-01 00:00:00',
    };
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(job), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...job, status: 'CLAIMED', claimToken: 'claim_1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...job, status: 'CLAIMED', claimToken: 'claim_1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [job] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...job, status: 'APPROVED' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...job, status: 'APPROVED' }), { status: 200 }));

    const tracker = httpIssueTracker('http://tracker');
    await tracker.createAutomationJob?.({
      issueKey: 'AD-1',
      sourceRevision: 'abc',
      idempotencyKey: 'AD-1:abc:1',
    });
    await tracker.claimAutomationJob?.('job_1', 'batch-1');
    await tracker.heartbeatAutomationJob?.('job_1', 'claim_1');
    await tracker.listAutomationJobs?.({ review: true });
    await tracker.patchAutomationJob?.('job_1', { claimToken: 'claim_1', status: 'RUNNING' });
    await tracker.reviewAutomationJob?.('job_1', { action: 'APPROVE', reviewerId: 'jay' });

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://tracker/automation/jobs/', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://tracker/automation/jobs/job_1/claim', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'http://tracker/automation/jobs/job_1/heartbeat', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'http://tracker/automation/jobs/?review=true');
    expect(fetchMock).toHaveBeenNthCalledWith(5, 'http://tracker/automation/jobs/job_1', expect.objectContaining({ method: 'PATCH' }));
    expect(fetchMock).toHaveBeenNthCalledWith(6, 'http://tracker/automation/jobs/job_1/review', expect.objectContaining({ method: 'POST' }));
  });
});
