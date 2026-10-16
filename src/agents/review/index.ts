import type { RunResult } from '../../lib/runner.js';
import { defaultWorkspaceDir } from '../../lib/workspace.js';
import { captureReviewFindings, projectFindingKey } from '../../lib/review-findings.js';
import { runNamedAgent, type AgentRunOpts } from '../dispatch.js';

export async function review(input: string, opts: AgentRunOpts = {}): Promise<RunResult> {
  const result = await runNamedAgent('review', input, opts);
  captureReviewFindings(
    result.output,
    result.runId,
    opts.workflowRunId ?? result.runId,
    projectFindingKey(opts.cwd ?? defaultWorkspaceDir()),
  );
  return result;
}
