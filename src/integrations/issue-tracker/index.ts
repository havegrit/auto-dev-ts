export type {
  AutomationJob,
  AutomationJobCreateInput,
  AutomationJobListOptions,
  AutomationJobPatchInput,
  AutomationJobReviewInput,
  AutomationJobStatus,
  IssueCommentInput,
  IssueRef,
  IssueTracker,
  IssueTrackerProvider,
} from './types.js';
export { httpIssueTracker } from './client.js';
export { planeIssueTracker, readPlaneIssueTrackerConfig } from './plane.js';
export { noopIssueTracker } from './noop.js';

import { httpIssueTracker } from './client.js';
import { planeIssueTracker, readPlaneIssueTrackerConfig } from './plane.js';
import { noopIssueTracker } from './noop.js';
import type { IssueTracker } from './types.js';

export function getIssueTracker(): IssueTracker {
  const base = process.env.AUTO_DEV_ISSUE_TRACKER_URL;
  const planeConfigured = [
    'AUTO_DEV_PLANE_BASE_URL',
    'AUTO_DEV_PLANE_WORKSPACE_SLUG',
    'AUTO_DEV_PLANE_PROJECT_ID',
    'AUTO_DEV_PLANE_API_KEY',
    'AUTO_DEV_PLANE_AI_WAIT_STATE_ID',
  ].some((name) => Boolean(process.env[name]?.trim()));
  const configuredProvider = process.env.AUTO_DEV_ISSUE_TRACKER?.trim().toLowerCase() || undefined;
  const provider = configuredProvider ?? (planeConfigured ? 'plane' : base ? 'http' : 'noop');

  if (provider === 'plane') return planeIssueTracker(readPlaneIssueTrackerConfig());
  if (provider === 'http') {
    if (!base?.trim()) throw new Error('AUTO_DEV_ISSUE_TRACKER_URL is required when AUTO_DEV_ISSUE_TRACKER=http');
    return httpIssueTracker(base);
  }
  if (provider === 'noop') return noopIssueTracker;
  throw new Error(`Unsupported AUTO_DEV_ISSUE_TRACKER provider: ${provider}`);
}
