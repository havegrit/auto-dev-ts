export interface IssueRef {
  key: string;
  title: string;
  description: string;
  type: string;
  priority: string;
  status: string;
  updatedAt: string;
}

export type AutomationJobStatus =
  | 'READY'
  | 'CLAIMED'
  | 'RUNNING'
  | 'BLOCKED'
  | 'COMMITTED_PENDING_REVIEW'
  | 'REWORK_REQUIRED'
  | 'APPROVED'
  | 'REJECTED'
  | 'FAILED';

export interface AutomationJob {
  id: string;
  issueKey: string;
  issueTitle: string;
  issueStatus: string;
  sourceRevision: string;
  taskVersion: number;
  idempotencyKey: string;
  priority: string;
  executionMode: 'AUTO' | 'MANUAL';
  status: AutomationJobStatus;
  instanceId?: string;
  claimToken?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  attemptCount: number;
  baseBranch?: string;
  baseRevision?: string;
  branchName?: string;
  worktreePath?: string;
  commitSha?: string;
  linkedRunId?: string;
  failureIssueKey?: string;
  lastError?: string;
  reviewedBy?: string;
  reviewNote?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  reviewedAt?: string;
}

export interface AutomationJobCreateInput {
  issueKey: string;
  sourceRevision: string;
  taskVersion?: number;
  idempotencyKey: string;
  priority?: string;
  executionMode?: 'AUTO' | 'MANUAL';
  baseBranch?: string;
}

export interface AutomationJobPatchInput {
  claimToken: string;
  status?: AutomationJobStatus;
  baseBranch?: string;
  baseRevision?: string;
  branchName?: string;
  worktreePath?: string;
  commitSha?: string;
  linkedRunId?: string;
  failureIssueKey?: string;
  lastError?: string;
}

export interface AutomationJobReviewInput {
  action: 'APPROVE' | 'REWORK' | 'REJECT' | 'RETRY';
  reviewerId: string;
  note?: string;
}

export interface AutomationJobListOptions {
  status?: AutomationJobStatus;
  issueKey?: string;
  review?: boolean;
}

export interface IssueTracker {
  fetchOpenIssues(): Promise<IssueRef[]>;
  getIssue?(key: string): Promise<IssueRef | null>;
  updateIssue?(key: string, patch: { status?: string; linkedRunId?: string }): Promise<void>;
  createAutomationJob?(input: AutomationJobCreateInput): Promise<AutomationJob>;
  listAutomationJobs?(options?: AutomationJobListOptions): Promise<AutomationJob[]>;
  claimAutomationJob?(id: string, instanceId: string, leaseSeconds?: number): Promise<AutomationJob>;
  heartbeatAutomationJob?(id: string, claimToken: string, leaseSeconds?: number): Promise<AutomationJob>;
  patchAutomationJob?(id: string, input: AutomationJobPatchInput): Promise<AutomationJob>;
  reviewAutomationJob?(id: string, input: AutomationJobReviewInput): Promise<AutomationJob>;
}
