import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runNamedAgent, loadGlobalSkill } = vi.hoisted(() => ({
  runNamedAgent: vi.fn(),
  loadGlobalSkill: vi.fn((name: string) => `skill:${name}`),
}));

vi.mock('../agents/dispatch.js', () => ({ runNamedAgent }));
vi.mock('../lib/skill-loader.js', () => ({ loadGlobalSkill }));

import {
  ATOMIC_COMMIT_STEP,
  commitSuccessfulSpec,
  DOCS_CHECK_STEP,
} from './post-success-commit.js';

const runOpts = {
  workflowRunId: 'workflow-1',
  specSessionId: 'spec-1',
  cwd: '/project',
};

function result(runId: string, output: string, status = 'DONE') {
  return { runId, output, status, durationMs: 10, tokensIn: 1, tokensOut: 1 };
}

describe('commitSuccessfulSpec', () => {
  beforeEach(() => {
    runNamedAgent.mockReset();
    loadGlobalSkill.mockClear();
  });

  it('runs the docs skill before the atomic commit skill with shared workflow context', async () => {
    runNamedAgent
      .mockResolvedValueOnce(result('docs-run', 'Docs updated: README.md\n[DOCS: READY]'))
      .mockResolvedValueOnce(result('commit-run', 'abc1234 fix: finish feature\n[COMMIT: DONE]'));

    const completed = await commitSuccessfulSpec({
      specContent: '원본 요청',
      clarifiedSpec: '확정 범위',
      planOutput: 'PLAN:\n1. scaffold | build\n2. review | verify\nEND.',
      runOpts,
    });

    expect(loadGlobalSkill.mock.calls.map(([name]) => name)).toEqual([
      DOCS_CHECK_STEP,
      ATOMIC_COMMIT_STEP,
    ]);
    expect(runNamedAgent.mock.calls.map(([name]) => name)).toEqual([
      DOCS_CHECK_STEP,
      ATOMIC_COMMIT_STEP,
    ]);
    expect(runNamedAgent.mock.calls[0][1]).toContain('skill:checking-docs-before-commit');
    expect(runNamedAgent.mock.calls[1][1]).toContain('skill:atomic-commit');
    expect(runNamedAgent.mock.calls[1][1]).toContain('[DOCS: READY]');
    expect(runNamedAgent.mock.calls[1][2]).toEqual(runOpts);
    expect(completed.failure).toBeUndefined();
    expect(Object.keys(completed.steps)).toEqual([DOCS_CHECK_STEP, ATOMIC_COMMIT_STEP]);
  });

  it('accepts a no-changes commit result as success', async () => {
    runNamedAgent
      .mockResolvedValueOnce(result('docs-run', 'No docs affected (no behavior change)\n[DOCS: READY]'))
      .mockResolvedValueOnce(result('commit-run', '[COMMIT: NO-CHANGES]'));

    const completed = await commitSuccessfulSpec({
      specContent: '검토 요청',
      clarifiedSpec: '검토 요청',
      runOpts,
    });

    expect(completed.failure).toBeUndefined();
  });

  it('does not run atomic commit when the docs check is not ready', async () => {
    runNamedAgent.mockResolvedValueOnce(result('docs-run', 'README translation is stale'));

    const completed = await commitSuccessfulSpec({
      specContent: '원본 요청',
      clarifiedSpec: '확정 범위',
      runOpts,
    });

    expect(runNamedAgent).toHaveBeenCalledTimes(1);
    expect(completed.failure).toMatchObject({
      step: DOCS_CHECK_STEP,
      status: 'BLOCKED',
      cause: 'invalid_output',
    });
  });

  it('blocks before running agents when either required global skill is unavailable', async () => {
    loadGlobalSkill.mockImplementationOnce(() => { throw new Error('missing skill'); });

    const completed = await commitSuccessfulSpec({
      specContent: '원본 요청',
      clarifiedSpec: '확정 범위',
      runOpts,
    });

    expect(runNamedAgent).not.toHaveBeenCalled();
    expect(completed.failure).toMatchObject({
      step: DOCS_CHECK_STEP,
      cause: 'skill_unavailable',
      reason: 'missing skill',
    });
  });
});
