import { Hono } from 'hono';
import { getAgent, listAgents } from '../agents/index.js';
import { clarifier } from '../agents/clarifier.js';
import { runSpec, runSpecBackground } from '../workflows/spec.js';
import { getRun, getRecentRuns, getRunsByWorkflowId, getStats } from '../store/runs.js';
import { costGuard } from '../lib/cost-guard.js';
import { runAgentBackground } from '../lib/runner.js';

export function createRoutes(): Hono {
  const app = new Hono();

  app.get('/api/status', (c) => {
    return c.json({
      status: 'ok',
      agents: listAgents(),
      guard: costGuard.stats(),
    });
  });

  app.post('/api/agents/:name', async (c) => {
    const name = c.req.param('name');
    const agent = getAgent(name);
    if (!agent) return c.json({ error: `Unknown agent: ${name}` }, 404);

    const body = await c.req.json<{ input: string; triggerSource?: string; triggerDetail?: string; workflowRunId?: string }>();
    if (!body.input) return c.json({ error: 'input is required' }, 400);

    try {
      const result = await agent(body.input, {
        triggerSource: body.triggerSource ?? 'api',
        triggerDetail: body.triggerDetail,
        workflowRunId: body.workflowRunId,
      });
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  app.post('/api/clarify', async (c) => {
    const body = await c.req.json<{ input: string }>();
    if (!body.input) return c.json({ error: 'input is required' }, 400);
    try {
      const result = await clarifier(body.input, { triggerSource: 'api' });
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  app.post('/api/specs', async (c) => {
    const body = await c.req.json<{ content: string; steps?: string[]; iterations?: number }>();
    if (!body.content) return c.json({ error: 'content is required' }, 400);
    try {
      const steps = body.steps ? new Set(body.steps) : undefined;
      const result = await runSpec(body.content, { steps, iterations: body.iterations, triggerSource: 'api' });
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  app.post('/api/submit', async (c) => {
    const body = await c.req.parseBody();
    const agentName = String(body['agent'] ?? 'spec');
    let input = String(body['input'] ?? '');

    const file = body['file'];
    if (file instanceof File && file.size > 0) {
      input = await file.text();
    }

    if (!input.trim()) return c.json({ error: 'input 또는 파일이 필요합니다' }, 400);

    if (agentName === 'spec') {
      const stepsRaw = String(body['steps'] ?? '');
      const steps = stepsRaw
        ? new Set(stepsRaw.split(',').map((s: string) => s.trim()).filter(Boolean))
        : undefined;
      const iterations = body['iterations'] ? Number(body['iterations']) : undefined;
      const runId = runSpecBackground(input, { steps, iterations, triggerSource: 'dashboard' });
      return c.json({ runId, type: 'workflow' });
    }

    const agent = getAgent(agentName);
    if (!agent) return c.json({ error: `Unknown agent: ${agentName}` }, 404);

    const runId = runAgentBackground({
      name: agentName,
      prompt: input,
      triggerSource: 'dashboard',
    });
    return c.json({ runId, type: 'agent' });
  });

  app.get('/api/runs', (c) => {
    const limit = Number(c.req.query('limit') ?? '20');
    return c.json(getRecentRuns(limit));
  });

  app.get('/api/runs/:id/children', (c) => {
    return c.json(getRunsByWorkflowId(c.req.param('id')));
  });

  app.get('/api/runs/:id', (c) => {
    const run = getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'Not found' }, 404);
    return c.json(run);
  });

  app.get('/api/stats', (c) => {
    return c.json(getStats());
  });

  return app;
}
