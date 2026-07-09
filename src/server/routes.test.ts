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
