import type {
  AutomationJob,
  AutomationJobCreateInput,
  AutomationJobListOptions,
  AutomationJobPatchInput,
  AutomationJobReviewInput,
  IssueRef,
  IssueTracker,
} from './types.js';

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

interface IssueListRaw {
  items?: IssueTrackerRaw[];
}

interface AutomationJobRaw {
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

  async function readError(res: Response, operation: string): Promise<Error> {
    let detail = `${res.status}`;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // Keep the HTTP status when the server did not return JSON.
    }
    return new Error(`issue-tracker ${operation} failed: ${detail}`);
  }

  function mapAutomationJob(raw: AutomationJobRaw): AutomationJob {
    return raw as unknown as AutomationJob;
  }

  return {
    async fetchOpenIssues(): Promise<IssueRef[]> {
      const res = await fetch(`${base}/issues/?status=${encodeURIComponent(statusFilter)}`);
      if (!res.ok) throw await readError(res, 'GET /issues');
      const data = await res.json() as IssueListRaw | IssueTrackerRaw[];
      const items = Array.isArray(data) ? data : data.items ?? [];
      return items.map(mapIssue);
    },

    async getIssue(key: string): Promise<IssueRef | null> {
      const encodedKey = encodeURIComponent(key);
      const res = await fetch(`${base}/issues/${encodedKey}`);
      if (res.status === 404) return null;
      if (!res.ok) throw await readError(res, `GET /issues/${key}`);
      return mapIssue(await res.json() as IssueTrackerRaw);
    },

    async updateIssue(key: string, patch: { status?: string; linkedRunId?: string }): Promise<void> {
      const encodedKey = encodeURIComponent(key);
      const res = await fetch(`${base}/issues/${encodedKey}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw await readError(res, `PATCH /issues/${key}`);
    },

    async createAutomationJob(input: AutomationJobCreateInput): Promise<AutomationJob> {
      const res = await fetch(`${base}/automation/jobs/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw await readError(res, 'POST /automation/jobs');
      return mapAutomationJob(await res.json() as AutomationJobRaw);
    },

    async listAutomationJobs(options: AutomationJobListOptions = {}): Promise<AutomationJob[]> {
      const params = new URLSearchParams();
      if (options.status) params.set('status', options.status);
      if (options.issueKey) params.set('issueKey', options.issueKey);
      if (options.review) params.set('review', 'true');
      const query = params.toString();
      const res = await fetch(`${base}/automation/jobs/${query ? `?${query}` : ''}`);
      if (!res.ok) throw await readError(res, 'GET /automation/jobs');
      const data = await res.json() as { items?: AutomationJobRaw[] };
      return (data.items ?? []).map(mapAutomationJob);
    },

    async claimAutomationJob(id: string, instanceId: string, leaseSeconds?: number): Promise<AutomationJob> {
      const res = await fetch(`${base}/automation/jobs/${encodeURIComponent(id)}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId, ...(leaseSeconds === undefined ? {} : { leaseSeconds }) }),
      });
      if (!res.ok) throw await readError(res, `POST /automation/jobs/${id}/claim`);
      return mapAutomationJob(await res.json() as AutomationJobRaw);
    },

    async heartbeatAutomationJob(id: string, claimToken: string, leaseSeconds?: number): Promise<AutomationJob> {
      const res = await fetch(`${base}/automation/jobs/${encodeURIComponent(id)}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimToken, ...(leaseSeconds === undefined ? {} : { leaseSeconds }) }),
      });
      if (!res.ok) throw await readError(res, `POST /automation/jobs/${id}/heartbeat`);
      return mapAutomationJob(await res.json() as AutomationJobRaw);
    },

    async patchAutomationJob(id: string, input: AutomationJobPatchInput): Promise<AutomationJob> {
      const res = await fetch(`${base}/automation/jobs/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw await readError(res, `PATCH /automation/jobs/${id}`);
      return mapAutomationJob(await res.json() as AutomationJobRaw);
    },

    async reviewAutomationJob(id: string, input: AutomationJobReviewInput): Promise<AutomationJob> {
      const res = await fetch(`${base}/automation/jobs/${encodeURIComponent(id)}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw await readError(res, `POST /automation/jobs/${id}/review`);
      return mapAutomationJob(await res.json() as AutomationJobRaw);
    },
  };
}
