import { Hono } from 'hono';
import { getAgent, listAgents } from '../agents/index.js';
import { clarifier } from '../agents/clarifier.js';
import { runSpec } from '../workflows/spec.js';
import { getRun, getRecentRuns, getStats } from '../store/runs.js';
import { costGuard } from '../lib/cost-guard.js';

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

  app.get('/api/runs', (c) => {
    const limit = Number(c.req.query('limit') ?? '20');
    return c.json(getRecentRuns(limit));
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
