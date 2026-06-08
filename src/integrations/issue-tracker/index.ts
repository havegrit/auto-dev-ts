export type { IssueRef, IssueTracker } from './types.js';
export { httpIssueTracker } from './client.js';
export { noopIssueTracker } from './noop.js';

import { httpIssueTracker } from './client.js';
import { noopIssueTracker } from './noop.js';
import type { IssueTracker } from './types.js';

export function getIssueTracker(): IssueTracker {
  const base = process.env.AUTO_DEV_ISSUE_TRACKER_URL;
  return base ? httpIssueTracker(base) : noopIssueTracker;
}
