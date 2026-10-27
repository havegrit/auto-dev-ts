import { beforeEach, describe, expect, it, vi } from 'vitest';
import { planeIssueTracker, type PlaneIssueTrackerConfig } from './plane.js';

const fetchMock = vi.fn<typeof fetch>();

const config: PlaneIssueTrackerConfig = {
  baseUrl: 'https://plane.example.test',
  workspaceSlug: 'acme',
  projectId: 'project-uuid',
  apiKey: 'secret-key',
  states: { aiWait: 'state-ai', inProgress: 'state-progress', done: 'state-done', humanReview: 'state-human' },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function states() {
  return json({ data: [
    { id: 'state-ai', name: 'AI Wait', group: 'unstarted' },
    { id: 'state-progress', name: 'In Progress', group: 'started' },
    { id: 'state-done', name: 'Done', group: 'completed' },
    { id: 'state-human', name: 'Human Review', group: 'started' },
  ] });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('Plane v2 issue tracker', () => {
  it('reads every cursor page and maps issues in the configured AI-wait state', async () => {
    fetchMock
      .mockResolvedValueOnce(states())
      .mockResolvedValueOnce(json({
        data: [{
          id: 'issue-1', identifier: 'ACME-1', name: 'Fix <widget>', description_html: '<p>Details &amp; notes</p>',
          type: { name: 'Bug' }, priority: 'high', state_id: 'state-ai', created_by_id: 'user-1', updated_at: 'now', project_id: 'project-uuid',
        }, {
          id: 'issue-progress', identifier: 'ACME-3', name: 'Already running', description_html: '',
          type_id: 'type-1', priority: 'low', state_id: 'state-progress', updated_at: 'now', project_id: 'project-uuid',
        }],
        pagination: { style: 'cursor' }, has_more: true, next_cursor: 'next-page',
      }))
      .mockResolvedValueOnce(json({
        data: [{
          id: 'issue-2', identifier: 'ACME-2', name: 'Add guard', description_html: '',
          type_id: 'type-1', priority: 'none', state_id: 'state-ai', updated_at: 'later', project_id: 'project-uuid',
        }],
        pagination: { style: 'cursor' }, has_more: false, next_cursor: null,
      }));

    const tracker = planeIssueTracker(config);
    await expect(tracker.fetchOpenIssues()).resolves.toEqual([
      expect.objectContaining({ key: 'ACME-1', description: 'Details & notes', status: 'OPEN', requesterId: 'user-1', priority: 'HIGH' }),
      expect.objectContaining({ key: 'ACME-2', status: 'OPEN', type: '' }),
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(1,
      expect.stringContaining('/api/v2/workspaces/acme/projects/project-uuid/states/?'),
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Api-Key': 'secret-key' }) }));
    expect(fetchMock.mock.calls[1][0]).not.toContain('state_id=');
    expect(fetchMock.mock.calls[2][0]).toContain('cursor=next-page');
  });

  it('fetches an issue, changes its state, and upserts a run comment using the work-item ID', async () => {
    fetchMock
      .mockResolvedValueOnce(states())
      .mockResolvedValueOnce(json({
        id: 'issue-uuid', identifier: 'ACME-9', name: 'Task', description_html: '', type: { name: 'Task' },
        priority: 'medium', state_id: 'state-ai', created_by_id: 'requester', project_id: 'project-uuid',
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({
        id: 'issue-uuid', identifier: 'ACME-9', name: 'Task', description_html: '', type: { name: 'Task' },
        priority: 'medium', state_id: 'state-ai', project_id: 'project-uuid',
      }))
      .mockResolvedValueOnce(json({ id: 'comment-1' }, 201));

    const tracker = planeIssueTracker(config);
    await expect(tracker.getIssue?.('ACME-9')).resolves.toMatchObject({ key: 'ACME-9', requesterId: 'requester' });
    await tracker.updateIssue?.('ACME-9', { status: 'IN_PROGRESS', linkedRunId: 'run-1' });
    await tracker.addComment?.('ACME-9', { externalId: 'run-1:scaffold', html: '<p>Done</p>' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/work-items/ACME-9/?expand=state,type'),
      expect.any(Object),
    );
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ state_id: 'state-progress' }) });
    expect(fetchMock.mock.calls[4][0]).toContain('/work-items/issue-uuid/comments/upsert/');
    expect(fetchMock.mock.calls[4][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ comment_html: '<p>Done</p>', access: 'INTERNAL', external_source: 'auto-dev', external_id: 'run-1:scaffold' }),
    });
  });

  it('rejects invalid state configuration before listing work items', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ id: 'state-ai', group: 'triage' }] }));
    await expect(planeIssueTracker(config).fetchOpenIssues()).rejects.toThrow(/state configuration is invalid/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('preserves Plane authentication failures as provider errors', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'Invalid API key' }, 401));
    await expect(planeIssueTracker(config).fetchOpenIssues()).rejects.toThrow(/Plane GET .* failed \(401\)/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
