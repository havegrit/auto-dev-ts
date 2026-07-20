import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/complete.js', () => ({
  complete: vi.fn(),
  parseJsonLoose: vi.fn(),
}));
vi.mock('../lib/workspace.js', () => ({
  resolveProjectDir: vi.fn((project?: string) => project ?? '/tmp/proj'),
  listProjects: vi.fn(() => []),
  WORKSPACE_ROOT: '/tmp/workspace',
}));
vi.mock('../agents/index.js', () => ({
  getAgent: vi.fn(),
  listAgents: vi.fn(() => []),
}));
vi.mock('../agents/dispatch.js', () => ({
  runNamedAgentBackground: vi.fn(),
}));
vi.mock('../agents/clarifier.js', () => ({
  clarifier: vi.fn(),
}));
vi.mock('../workflows/spec.js', () => ({
  runSpec: vi.fn(),
}));
vi.mock('../workflows/spec-session.js', () => ({
  startSpecSession: vi.fn(),
  resumeSpecSession: vi.fn(),
  continueSpecSession: vi.fn(),
  resumeLastSpecStep: vi.fn(),
  pendingClarification: vi.fn(),
  specRunPlan: vi.fn(),
}));
vi.mock('../store/runs.js', () => ({
  getRun: vi.fn(() => ({ status: 'RUNNING' })),
  getRecentRunUnits: vi.fn(),
  getRunsByWorkflowId: vi.fn(),
  getStats: vi.fn(() => ({})),
  updateRun: vi.fn(),
}));
vi.mock('../store/run-events.js', () => ({
  getRunEvents: vi.fn(() => []),
}));
vi.mock('../lib/cost-guard.js', () => ({
  costGuard: { stats: vi.fn(() => ({ limit: null })) },
}));
vi.mock('../lib/circuit-breaker.js', () => ({
  circuitBreaker: { stats: vi.fn(() => ({ state: 'CLOSED' })) },
}));
vi.mock('../lib/model-config.js', () => ({
  modelConfig: { stats: vi.fn(() => ({})), set: vi.fn() },
}));
vi.mock('../lib/run-events.js', () => ({
  getOrCreateEmitter: vi.fn(),
}));
vi.mock('../lib/run-cancellation.js', () => ({
  cancelActiveRun: vi.fn(() => true),
}));
vi.mock('../integrations/issue-tracker/index.js', () => ({
  getIssueTracker: vi.fn(() => ({
    fetchOpenIssues: vi.fn(),
    updateIssue: vi.fn(),
  })),
}));
vi.mock('../workflows/from-issue.js', () => ({
  processIssue: vi.fn(),
}));

import { createRoutes } from './routes.js';
import { resolveProjectDir } from '../lib/workspace.js';
import { getAgent } from '../agents/index.js';
import { runSpec } from '../workflows/spec.js';
import { startSpecSession, resumeSpecSession } from '../workflows/spec-session.js';
import { cancelActiveRun } from '../lib/run-cancellation.js';
import { getRun, updateRun } from '../store/runs.js';

describe('dashboard auto-clarify options', () => {
  it('passes an unlimited round setting from the submit form', async () => {
    vi.mocked(startSpecSession).mockReturnValueOnce({ runId: 'spec-run', done: Promise.resolve() });
    const body = new FormData();
    body.set('agent', 'spec');
    body.set('input', 'clarify and build');
    body.set('project', 'demo');
    body.set('autoClarify', 'true');
    body.set('maxClarifyRounds', '0');

    const app = createRoutes();
    const res = await app.fetch(new Request('http://localhost/api/submit', { method: 'POST', body }));

    expect(res.status).toBe(200);
    expect(startSpecSession).toHaveBeenCalledWith('clarify and build', expect.objectContaining({
      autoClarify: true,
      maxClarifyRounds: 0,
    }));
  });

  it('rejects invalid maximum rounds', async () => {
    const body = new FormData();
    body.set('agent', 'spec');
    body.set('input', 'clarify and build');
    body.set('project', 'demo');
    body.set('autoClarify', 'true');
    body.set('maxClarifyRounds', '-1');

    const app = createRoutes();
    const res = await app.fetch(new Request('http://localhost/api/submit', { method: 'POST', body }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'maxClarifyRounds must be a non-negative integer' });
  });

  it('passes auto-clarify settings when resuming from answers', async () => {
    vi.mocked(resumeSpecSession).mockReturnValueOnce({ runId: 'resumed-run', done: Promise.resolve() });
    const app = createRoutes();
    const res = await app.fetch(new Request('http://localhost/api/runs/stopped-run/answers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        answers: { q1: 'answer' },
        autoClarify: true,
        maxClarifyRounds: 0,
      }),
    }));

    expect(res.status).toBe(200);
    expect(resumeSpecSession).toHaveBeenCalledWith(
      'stopped-run',
      { q1: 'answer' },
      undefined,
      undefined,
      { autoClarify: true, maxClarifyRounds: 0 },
    );
  });
});

describe('routes resume-last guard', () => {
  it('rejects resume-last for a running run', async () => {
    const app = createRoutes();
    const res = await app.fetch(new Request('http://localhost/api/runs/run-1/resume-last', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'Cannot resume-last while the run is still running' });
  });
});

describe('run cancellation', () => {
  it('accepts cancellation for a running run', async () => {
    const app = createRoutes();
    const res = await app.fetch(new Request('http://localhost/api/runs/run-1/cancel', { method: 'POST' }));

    expect(res.status).toBe(202);
    expect(cancelActiveRun).toHaveBeenCalledWith('run-1');
    await expect(res.json()).resolves.toEqual({ accepted: true, runId: 'run-1' });
  });

  it('records elapsed time immediately when cancellation is accepted', async () => {
    const startedAt = new Date(Date.now() - 1500).toISOString();
    vi.mocked(getRun).mockReturnValueOnce({ status: 'RUNNING', started_at: startedAt } as any);
    const app = createRoutes();

    const res = await app.fetch(new Request('http://localhost/api/runs/run-1/cancel', { method: 'POST' }));

    expect(res.status).toBe(202);
    expect(updateRun).toHaveBeenCalledWith('run-1', expect.objectContaining({
      durationMs: expect.any(Number),
    }));
    const duration = vi.mocked(updateRun).mock.calls.at(-1)?.[1].durationMs;
    expect(duration).toBeGreaterThanOrEqual(1000);
  });
});

describe('workspace cwd guard', () => {
  it('rejects absolute cwd on /api/specs through resolveProjectDir', async () => {
    vi.mocked(resolveProjectDir).mockImplementationOnce(() => {
      throw new Error('Invalid project name: /tmp/outside');
    });
    const app = createRoutes();

    const res = await app.fetch(new Request('http://localhost/api/specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'build it', cwd: '/tmp/outside' }),
    }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid project name: /tmp/outside' });
    expect(runSpec).not.toHaveBeenCalled();
  });

  it('rejects absolute cwd on /api/agents through resolveProjectDir', async () => {
    vi.mocked(getAgent).mockReturnValueOnce(vi.fn());
    vi.mocked(resolveProjectDir).mockImplementationOnce(() => {
      throw new Error('Invalid project name: /tmp/outside');
    });
    const app = createRoutes();

    const res = await app.fetch(new Request('http://localhost/api/agents/scaffold', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'build it', cwd: '/tmp/outside' }),
    }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid project name: /tmp/outside' });
  });
});
