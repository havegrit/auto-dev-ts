import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { complete, parseJsonLoose } from '../lib/complete.js';
import { resolveProjectDir, listProjects, WORKSPACE_ROOT } from '../lib/workspace.js';
import { getAgent, listAgents } from '../agents/index.js';
import { runNamedAgentBackground } from '../agents/dispatch.js';
import { clarifier } from '../agents/clarifier.js';
import { runSpec } from '../workflows/spec.js';
import { startSpecSession, resumeSpecSession, pendingClarification } from '../workflows/spec-session.js';
import { getRun, getRecentRuns, getRunsByWorkflowId, getStats } from '../store/runs.js';
import { costGuard } from '../lib/cost-guard.js';
import { circuitBreaker } from '../lib/circuit-breaker.js';
import { modelConfig } from '../lib/model-config.js';
import { getOrCreateEmitter } from '../lib/run-events.js';
import { getIssueTracker } from '../integrations/issue-tracker/index.js';
import { processIssue } from '../workflows/from-issue.js';

export function createRoutes(): Hono {
  const app = new Hono();

  // 인터뷰 등 외부 정적 앱(다른 포트)에서 LLM 프록시를 호출할 수 있도록 허용 (루프백 전용)
  app.use('/api/*', cors());

  // Claude 구독으로 단발성 completion을 수행하는 프록시 (브라우저 직접 API 호출 대체)
  app.post('/api/llm/complete', async (c) => {
    const body = await c.req.json<{ system?: string; message?: string; json?: boolean; model?: string }>();
    if (!body.message) return c.json({ error: 'message is required' }, 400);
    try {
      const text = await complete({ system: body.system, message: body.message, json: body.json, model: body.model });
      if (body.json) {
        try {
          return c.json({ text, data: parseJsonLoose(text) });
        } catch {
          return c.json({ text, data: null, parseError: true });
        }
      }
      return c.json({ text });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/api/status', (c) => {
    return c.json({
      status: 'ok',
      agents: listAgents(),
      guard: costGuard.stats().limit !== null ? costGuard.stats() : null,
      circuit: circuitBreaker.stats(),
    });
  });

  app.post('/api/agents/:name', async (c) => {
    const name = c.req.param('name');
    const agent = getAgent(name);
    if (!agent) return c.json({ error: `Unknown agent: ${name}` }, 404);

    const body = await c.req.json<{ input: string; triggerSource?: string; triggerDetail?: string; workflowRunId?: string; project?: string; cwd?: string }>();
    if (!body.input) return c.json({ error: 'input is required' }, 400);

    let cwd: string | undefined;
    try {
      // project명이 오면 워크스페이스 루트 기준으로 해석, 없으면 직접 cwd 경로 사용(하위호환)
      cwd = body.project !== undefined ? resolveProjectDir(body.project) : body.cwd;
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    try {
      const result = await agent(body.input, {
        triggerSource: body.triggerSource ?? 'api',
        triggerDetail: body.triggerDetail,
        workflowRunId: body.workflowRunId,
        cwd,
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
    const project = String(body['project'] ?? '').trim() || undefined;
    let cwd: string;
    try {
      cwd = resolveProjectDir(project);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

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
      const { runId } = startSpecSession(input, { project, cwd, steps, iterations, triggerSource: 'dashboard' });
      return c.json({ runId, type: 'workflow' });
    }

    // 에이전트의 시스템 프롬프트 + 역할 경계(tools)를 적용해 실행한다.
    // 원시 input 을 그대로 넘기면 프롬프트·권한 제한이 우회되므로 dispatch 를 거친다.
    const runId = runNamedAgentBackground(agentName, input, { triggerSource: 'dashboard', cwd });
    if (!runId) return c.json({ error: `Unknown agent: ${agentName}` }, 404);
    return c.json({ runId, type: 'agent' });
  });

  app.get('/api/runs', (c) => {
    const limit = Number(c.req.query('limit') ?? '20');
    return c.json(getRecentRuns(limit));
  });

  app.get('/api/runs/:id/children', (c) => {
    return c.json(getRunsByWorkflowId(c.req.param('id')));
  });

  app.get('/api/runs/:id/events', (c) => {
    const runId = c.req.param('id');
    const run = getRun(runId);

    return new Response(
      new ReadableStream({
        start(controller) {
          const enc = (data: string) => new TextEncoder().encode(data);
          const send = (obj: object) => controller.enqueue(enc(`data: ${JSON.stringify(obj)}\n\n`));

          if (!run || run.status !== 'RUNNING') {
            send({ type: 'status', ts: new Date().toISOString(), data: run?.status ?? 'NOT_FOUND' });
            controller.close();
            return;
          }

          const ee = getOrCreateEmitter(runId);
          const onEvent = (e: object) => { try { send(e); } catch {} };
          const onDone = () => { try { controller.close(); } catch {} };

          ee.on('event', onEvent);
          ee.once('done', onDone);

          c.req.raw.signal.addEventListener('abort', () => {
            ee.off('event', onEvent);
            ee.off('done', onDone);
          });
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } },
    );
  });

  app.get('/api/runs/:id', (c) => {
    const run = getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'Not found' }, 404);
    return c.json(run);
  });

  // clarifier 가 멈춘 run 의 대기 중 질문(추천 답안 포함)을 반환한다.
  app.get('/api/runs/:id/clarification', (c) => {
    const pending = pendingClarification(c.req.param('id'));
    return c.json({ questions: pending?.questions ?? [] });
  });

  // 질문 답변으로 워크플로우를 재개한다 (스펙 재입력 없이 연결된 새 run 생성).
  app.post('/api/runs/:id/answers', async (c) => {
    const body = await c.req.json<{ answers?: Record<string, string> }>();
    const answers = body.answers ?? {};
    if (Object.keys(answers).length === 0) return c.json({ error: 'answers is required' }, 400);
    try {
      const { runId } = resumeSpecSession(c.req.param('id'), answers);
      return c.json({ runId, type: 'workflow' });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get('/api/stats', (c) => {
    return c.json(getStats());
  });

  app.get('/api/config', (c) => {
    return c.json({ ...modelConfig.stats(), agents: listAgents(), workspaceRoot: WORKSPACE_ROOT, projects: listProjects() });
  });

  app.post('/api/config', async (c) => {
    const body = await c.req.json<{ model?: string; fallbackModel?: string; agentModels?: Record<string, string>; effort?: string }>();
    try {
      const options: { fallbackModel?: string; agentModels?: Record<string, string>; persist: boolean } = { persist: true };
      if (Object.prototype.hasOwnProperty.call(body, 'fallbackModel')) options.fallbackModel = body.fallbackModel || undefined;
      if (Object.prototype.hasOwnProperty.call(body, 'agentModels')) options.agentModels = body.agentModels;
      modelConfig.set(body.model ?? modelConfig.getModel(), body.effort ?? modelConfig.getEffort(), options);
      return c.json(modelConfig.stats());
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get('/api/issues', async (c) => {
    const tracker = getIssueTracker();
    try {
      const issues = await tracker.fetchOpenIssues();
      return c.json(issues);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 502);
    }
  });

  app.post('/api/issues/:key/run', async (c) => {
    const key = c.req.param('key');
    try {
      const result = await processIssue(key);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes('연동되지 않았습니다') || msg.includes('찾을 수 없습니다') ? 400 : 500;
      return c.json({ error: msg }, status);
    }
  });

  return app;
}
