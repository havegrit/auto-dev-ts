import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { complete, parseJsonLoose } from '../lib/complete.js';
import { resolveProjectDir, listProjects, WORKSPACE_ROOT } from '../lib/workspace.js';
import { getAgent, listAgents } from '../agents/index.js';
import { runNamedAgentBackground } from '../agents/dispatch.js';
import { clarifier } from '../agents/clarifier.js';
import { MAX_ROUTE_LIMIT, runSpec } from '../workflows/spec.js';
import { startSpecSession, resumeSpecSession, continueSpecSession, resumeLastSpecStep, pendingClarification, specRunPlan } from '../workflows/spec-session.js';
import type { ClarificationRound } from '../workflows/clarification.js';
import { getRun, getRecentRunUnits, getRunsByWorkflowId, getStats, updateRun } from '../store/runs.js';
import { getRunEvents } from '../store/run-events.js';
import { costGuard } from '../lib/cost-guard.js';
import { circuitBreaker } from '../lib/circuit-breaker.js';
import { loadModelsFromCli, modelConfig } from '../lib/model-config.js';
import { getOrCreateEmitter } from '../lib/run-events.js';
import { getIssueTracker } from '../integrations/issue-tracker/index.js';
import { processIssue } from '../workflows/from-issue.js';
import { cancelActiveRun } from '../lib/run-cancellation.js';
import { claudeAuth } from '../lib/claude-auth.js';

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized.startsWith('127.');
}

function isClaudeAuthRequestAllowed(request: Request): boolean {
  if (!isLoopbackHostname(process.env.AUTO_DEV_BIND_ADDR ?? '127.0.0.1')) return false;

  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(requestUrl.hostname)) return false;

  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    return isLoopbackHostname(originUrl.hostname) && originUrl.origin === requestUrl.origin;
  } catch {
    return false;
  }
}


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

  app.get('/api/auth/claude', async (c) => {
    if (!isClaudeAuthRequestAllowed(c.req.raw)) {
      return c.json({ error: 'Claude 인증은 루프백 대시보드에서만 사용할 수 있습니다.' }, 403);
    }
    return c.json(await claudeAuth.status());
  });

  app.post('/api/auth/claude/login', async (c) => {
    if (!isClaudeAuthRequestAllowed(c.req.raw)) {
      return c.json({ error: 'Claude 인증은 루프백 대시보드에서만 사용할 수 있습니다.' }, 403);
    }
    const status = await claudeAuth.start();
    if (status.phase === 'failed') return c.json(status, 502);
    return c.json(status);
  });

  app.post('/api/auth/claude/code', async (c) => {
    if (!isClaudeAuthRequestAllowed(c.req.raw)) {
      return c.json({ error: 'Claude 인증은 루프백 대시보드에서만 사용할 수 있습니다.' }, 403);
    }
    const body: { code?: string } = await c.req.json<{ code?: string }>().catch(() => ({}));
    if (!body.code) return c.json({ error: 'code is required' }, 400);
    try {
      const status = await claudeAuth.submitCode(body.code);
      await loadModelsFromCli();
      return c.json(status);
    } catch (err) {
      const status = await claudeAuth.status();
      return c.json({
        ...status,
        error: err instanceof Error ? err.message : String(err),
      }, 400);
    }
  });

  app.post('/api/agents/:name', async (c) => {
    const name = c.req.param('name');
    const agent = getAgent(name);
    if (!agent) return c.json({ error: `Unknown agent: ${name}` }, 404);

    const body = await c.req.json<{ input: string; triggerSource?: string; triggerDetail?: string; workflowRunId?: string; project?: string; cwd?: string; deliveryIntent?: 'ci' | 'cd' }>();
    if (!body.input) return c.json({ error: 'input is required' }, 400);

    let cwd: string | undefined;
    try {
      // cwd 하위호환 입력도 project와 동일하게 워크스페이스 루트 하위 상대 경로로만 해석한다.
      cwd = resolveProjectDir(body.project ?? body.cwd);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    try {
      const result = await agent(body.input, {
        triggerSource: body.triggerSource ?? 'api',
        triggerDetail: body.triggerDetail,
        workflowRunId: body.workflowRunId,
        cwd,
        deliveryIntent: body.deliveryIntent,
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
    const body = await c.req.json<{ content: string; steps?: string[]; iterations?: number; project?: string; cwd?: string; deliveryIntent?: 'ci' | 'cd' }>();
    if (!body.content) return c.json({ error: 'content is required' }, 400);
    if (body.iterations !== undefined && (!Number.isInteger(body.iterations) || body.iterations < 0 || body.iterations > MAX_ROUTE_LIMIT)) {
      return c.json({ error: `iterations must be an integer between 0 and ${MAX_ROUTE_LIMIT}` }, 400);
    }
    try {
      const steps = body.steps ? new Set(body.steps) : undefined;
      const cwd = resolveProjectDir(body.project ?? body.cwd, body.content);
      const result = await runSpec(body.content, { steps, iterations: body.iterations, triggerSource: 'api', cwd, deliveryIntent: body.deliveryIntent });
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.startsWith('Invalid project name') ? 400 : 500);
    }
  });

  app.post('/api/submit', async (c) => {
    const body = await c.req.parseBody();
    const agentName = String(body['agent'] ?? 'spec');
    let input = String(body['input'] ?? '');
    const project = String(body['project'] ?? '').trim() || undefined;

    const file = body['file'];
    if (file instanceof File && file.size > 0) {
      input = await file.text();
    }

    if (!input.trim()) return c.json({ error: 'input 또는 파일이 필요합니다' }, 400);

    let cwd: string;
    try {
      cwd = agentName === 'spec' && !project
        ? resolveProjectDir(undefined, input)
        : resolveProjectDir(project);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    if (agentName === 'spec') {
      const stepsRaw = String(body['steps'] ?? '');
      const steps = stepsRaw
        ? new Set(stepsRaw.split(',').map((s: string) => s.trim()).filter(Boolean))
        : undefined;
      const iterations = body['iterations'] ? Number(body['iterations']) : undefined;
      const autoClarify = String(body['autoClarify'] ?? '') === 'true';
      const maxClarifyRounds = Number(String(body['maxClarifyRounds'] ?? '0'));
      if (!Number.isInteger(maxClarifyRounds) || maxClarifyRounds < 0) {
        return c.json({ error: 'maxClarifyRounds must be a non-negative integer' }, 400);
      }
      if (iterations !== undefined && (!Number.isInteger(iterations) || iterations < 0 || iterations > MAX_ROUTE_LIMIT)) {
        return c.json({ error: `iterations must be an integer between 0 and ${MAX_ROUTE_LIMIT}` }, 400);
      }
      const deliveryIntent = String(body['deliveryIntent'] ?? '') === 'cd' ? 'cd' : 'ci';
      const { runId } = startSpecSession(input, { project, cwd, steps, iterations, autoClarify, maxClarifyRounds, deliveryIntent, triggerSource: 'dashboard' });
      return c.json({ runId, type: 'workflow' });
    }

    // 에이전트의 시스템 프롬프트 + 역할 경계(tools)를 적용해 실행한다.
    // 원시 input 을 그대로 넘기면 프롬프트·권한 제한이 우회되므로 dispatch 를 거친다.
    const deliveryIntent = String(body['deliveryIntent'] ?? '') === 'cd' ? 'cd' : 'ci';
    const runId = runNamedAgentBackground(agentName, input, { triggerSource: 'dashboard', cwd, deliveryIntent });
    if (!runId) return c.json({ error: `Unknown agent: ${agentName}` }, 404);
    return c.json({ runId, type: 'agent' });
  });

  app.get('/api/runs', (c) => {
    // units = 최근 실행 목록에 불러올 최상위 유닛(spec 워크플로우 또는 단독 실행) 개수.
    // 무한 스크롤이 스크롤할수록 이 값을 키워 재요청한다. { rows, hasMore } 를 돌려준다.
    const units = Number(c.req.query('units') ?? '10');
    return c.json(getRecentRunUnits(units));
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
          const onDone = () => {
            try {
              const finished = getRun(runId);
              send({ type: 'status', ts: new Date().toISOString(), data: finished?.status ?? 'DONE' });
              controller.close();
            } catch {}
          };

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

  app.get('/api/runs/:id/events/history', (c) => {
    return c.json({ events: getRunEvents(c.req.param('id')) });
  });

  app.get('/api/runs/:id', (c) => {
    const run = getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'Not found' }, 404);
    return c.json(run);
  });

  app.post('/api/runs/:id/cancel', (c) => {
    const runId = c.req.param('id');
    const run = getRun(runId);
    if (!run) return c.json({ error: 'Not found' }, 404);
    if (run.status !== 'RUNNING') return c.json({ error: `Run is not running: ${run.status}` }, 409);
    if (!cancelActiveRun(runId)) return c.json({ error: 'Run is not cancellable in this server process' }, 409);
    // Provider 종료/정리 지연으로 runner의 최종 저장이 늦어져도
    // 취소 시점까지의 경과시간은 즉시 보존한다. runner가 끝나면 더 정확한 값으로 갱신한다.
    const startedAt = new Date(run.started_at).getTime();
    if (Number.isFinite(startedAt)) {
      updateRun(runId, { durationMs: Math.max(0, Date.now() - startedAt) });
    }
    return c.json({ accepted: true, runId }, 202);
  });

  // clarifier 가 멈춘 run 의 대기 중 질문(추천 답안 포함)을 반환한다.
  app.get('/api/runs/:id/clarification', (c) => {
    const pending = pendingClarification(c.req.param('id'));
    return c.json({ questions: pending?.questions ?? [] });
  });

  // 질문 답변으로 워크플로우를 재개한다 (스펙 재입력 없이 연결된 새 run 생성).
  app.post('/api/runs/:id/answers', async (c) => {
    const body = await c.req.json<{ answers?: Record<string, string>; instruction?: string; questions?: ClarificationRound['questions']; autoClarify?: boolean; maxClarifyRounds?: number }>();
    const answers = body.answers ?? {};
    const instruction = (body.instruction ?? '').trim();
    if (Object.keys(answers).length === 0 && !instruction) {
      return c.json({ error: 'answers or instruction is required' }, 400);
    }
    const maxClarifyRounds = body.maxClarifyRounds;
    if (maxClarifyRounds !== undefined && (!Number.isInteger(maxClarifyRounds) || maxClarifyRounds < 0)) {
      return c.json({ error: 'maxClarifyRounds must be a non-negative integer' }, 400);
    }
    try {
      const { runId } = resumeSpecSession(c.req.param('id'), answers, instruction || undefined, body.questions, {
        autoClarify: body.autoClarify,
        maxClarifyRounds,
      });
      return c.json({ runId, type: 'workflow' });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // 이 run 의 이전 플랜 문서(원본 스펙 + 의사결정 히스토리 + 플랜)를 반환한다.
  app.get('/api/runs/:id/plan', (c) => {
    const plan = specRunPlan(c.req.param('id'));
    return c.json({ plan: plan ?? null });
  });

  // 완료된 spec run 을 사용자 후속 수정 지시로 이어 실행한다 (스펙 재입력 없이 새 run 생성).
  app.post('/api/runs/:id/continue', async (c) => {
    const body = await c.req.json<{ instruction?: string }>();
    try {
      const { runId } = continueSpecSession(c.req.param('id'), body.instruction ?? '');
      return c.json({ runId, type: 'workflow' });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // 실패했거나 다시 시도할 spec run 을 마지막으로 실행된 단계부터 재개한다.
  app.post('/api/runs/:id/resume-last', async (c) => {
    const body: { instruction?: string } = await c.req.json<{ instruction?: string }>().catch(() => ({}));
    const run = getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'Not found' }, 404);
    if (run.status === 'RUNNING') {
      return c.json({ error: 'Cannot resume-last while the run is still running' }, 409);
    }
    try {
      const { runId } = resumeLastSpecStep(c.req.param('id'), body.instruction);
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
