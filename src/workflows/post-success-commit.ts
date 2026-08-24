import { runNamedAgent, type AgentRunOpts } from '../agents/dispatch.js';
import { loadGlobalSkill } from '../lib/skill-loader.js';

export const DOCS_CHECK_STEP = 'checking-docs-before-commit';
export const ATOMIC_COMMIT_STEP = 'atomic-commit';

export interface PostSuccessStepResult {
  runId: string;
  durationMs: number;
  status: string;
}

export interface PostSuccessCommitResult {
  steps: Record<string, PostSuccessStepResult>;
  failure?: {
    step: string;
    status: string;
    reason: string;
    cause: 'agent_stopped' | 'invalid_output' | 'skill_unavailable';
  };
}

export interface PostSuccessCommitContext {
  specContent: string;
  clarifiedSpec: string;
  planOutput?: string;
  runOpts: AgentRunOpts;
}

function workflowContext(ctx: PostSuccessCommitContext): string {
  return [
    '## Completed spec request',
    ctx.specContent.trim(),
    '',
    '## Clarified implementation scope',
    ctx.clarifiedSpec.trim(),
    '',
    '## Planner output',
    ctx.planOutput?.trim() || '(planner output unavailable)',
  ].join('\n');
}

function stepResult(result: Awaited<ReturnType<typeof runNamedAgent>>): PostSuccessStepResult {
  return { runId: result.runId, durationMs: result.durationMs, status: result.status };
}

function stoppedFailure(step: string, result: Awaited<ReturnType<typeof runNamedAgent>>): NonNullable<PostSuccessCommitResult['failure']> {
  return {
    step,
    status: result.status,
    cause: 'agent_stopped',
    reason: result.output.trim() || `The ${step} agent stopped without an error message.`,
  };
}

/** Run the required docs audit, then create atomic commits for a successfully completed spec. */
export async function commitSuccessfulSpec(ctx: PostSuccessCommitContext): Promise<PostSuccessCommitResult> {
  const steps: Record<string, PostSuccessStepResult> = {};
  let docsSkill: string;
  let commitSkill: string;
  try {
    docsSkill = loadGlobalSkill(DOCS_CHECK_STEP);
    commitSkill = loadGlobalSkill(ATOMIC_COMMIT_STEP);
  } catch (err) {
    return {
      steps,
      failure: {
        step: DOCS_CHECK_STEP,
        status: 'BLOCKED',
        cause: 'skill_unavailable',
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const context = workflowContext(ctx);
  const docs = await runNamedAgent(DOCS_CHECK_STEP, [
    'Apply the following globally installed skill exactly before any commit:',
    '',
    docsSkill,
    '',
    context,
  ].join('\n'), ctx.runOpts);
  steps[DOCS_CHECK_STEP] = stepResult(docs);
  if (docs.status !== 'DONE') return { steps, failure: stoppedFailure(DOCS_CHECK_STEP, docs) };
  if (!/\[DOCS:\s*READY\]/i.test(docs.output)) {
    return {
      steps,
      failure: {
        step: DOCS_CHECK_STEP,
        status: 'BLOCKED',
        cause: 'invalid_output',
        reason: `Docs check did not confirm readiness.\n\nAgent output:\n${docs.output.trim() || '(no output)'}`,
      },
    };
  }

  const commit = await runNamedAgent(ATOMIC_COMMIT_STEP, [
    'Apply the following globally installed skill exactly. The required docs check already completed successfully:',
    '',
    commitSkill,
    '',
    context,
    '',
    '## Docs-check result',
    docs.output.trim(),
  ].join('\n'), ctx.runOpts);
  steps[ATOMIC_COMMIT_STEP] = stepResult(commit);
  if (commit.status !== 'DONE') return { steps, failure: stoppedFailure(ATOMIC_COMMIT_STEP, commit) };
  if (!/\[COMMIT:\s*(?:DONE|NO-CHANGES)\]/i.test(commit.output)) {
    return {
      steps,
      failure: {
        step: ATOMIC_COMMIT_STEP,
        status: 'BLOCKED',
        cause: 'invalid_output',
        reason: `Atomic commit did not confirm completion.\n\nAgent output:\n${commit.output.trim() || '(no output)'}`,
      },
    };
  }

  return { steps };
}
