import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createRoutes } from './routes.js';
import { loadModelsFromCli } from '../lib/model-config.js';
import { keepRunningAfterSessionDisconnect } from '../lib/session-lifecycle.js';

const ADDR = process.env.AUTO_DEV_BIND_ADDR ?? '127.0.0.1';
const PORT = Number(process.env.AUTO_DEV_BIND_PORT ?? '8080');

export async function startServer(): Promise<void> {
  // 대시보드가 SSH foreground 프로세스로 시작돼도 연결 종료와 함께
  // 실행 중인 background spec이 끊기지 않게 한다.
  keepRunningAfterSessionDisconnect();
  // 대시보드가 최초 요청부터 최신 모델 목록을 보도록 서버 listen 전에 갱신한다.
  await loadModelsFromCli();

  const app = new Hono();
  app.route('/', createRoutes());
  app.use('/*', serveStatic({ root: './static' }));
  serve({ fetch: app.fetch, hostname: ADDR, port: PORT }, (info) => {
    console.log(`auto-dev listening on http://${info.address}:${info.port}`);
  });
}
