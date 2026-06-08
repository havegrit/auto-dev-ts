import type { IssueTracker } from './types.js';

export const noopIssueTracker: IssueTracker = {
  async fetchOpenIssues() {
    return [];
  },
  async getIssue(_key) {
    return null;
  },
  async updateIssue(_key, _patch) {},
};
