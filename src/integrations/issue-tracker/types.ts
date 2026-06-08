export interface IssueRef {
  key: string;
  title: string;
  description: string;
  type: string;
  priority: string;
  status: string;
  updatedAt: string;
}

export interface IssueTracker {
  fetchOpenIssues(): Promise<IssueRef[]>;
  getIssue?(key: string): Promise<IssueRef | null>;
  updateIssue?(key: string, patch: { status?: string; linkedRunId?: string }): Promise<void>;
}
