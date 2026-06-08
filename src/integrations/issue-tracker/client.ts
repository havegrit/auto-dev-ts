import type { IssueRef, IssueTracker } from './types.js';

interface IssueTrackerRaw {
  key: string;
  title: string;
  description: string;
  type: string;
  priority: string;
  status: string;
  updatedAt: string;
  [key: string]: unknown;
}

function mapIssue(raw: IssueTrackerRaw): IssueRef {
  return {
    key: raw.key,
    title: raw.title,
    description: raw.description ?? '',
    type: raw.type,
    priority: raw.priority,
    status: raw.status,
    updatedAt: raw.updatedAt,
  };
}

export function httpIssueTracker(baseUrl: string): IssueTracker {
  const base = baseUrl.replace(/\/$/, '');
  const statusFilter = process.env.AUTO_DEV_ISSUE_TRACKER_STATUS ?? 'OPEN';

  return {
    async fetchOpenIssues(): Promise<IssueRef[]> {
      const res = await fetch(`${base}/issues?status=${statusFilter}`);
      if (!res.ok) throw new Error(`issue-tracker GET /issues failed: ${res.status}`);
      const data = await res.json() as IssueTrackerRaw[];
      return Array.isArray(data) ? data.map(mapIssue) : [];
    },

    async getIssue(key: string): Promise<IssueRef | null> {
      const res = await fetch(`${base}/issues/${key}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`issue-tracker GET /issues/${key} failed: ${res.status}`);
      return mapIssue(await res.json() as IssueTrackerRaw);
    },

    async updateIssue(key: string, patch: { status?: string; linkedRunId?: string }): Promise<void> {
      const res = await fetch(`${base}/issues/${key}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`issue-tracker PATCH /issues/${key} failed: ${res.status}`);
    },
  };
}
