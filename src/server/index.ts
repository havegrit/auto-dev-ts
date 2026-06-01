import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createRoutes } from './routes.js';

const ADDR = process.env.AUTO_DEV_BIND_ADDR ?? '127.0.0.1';
const PORT = Number(process.env.AUTO_DEV_BIND_PORT ?? '8080');

export function startServer(): void {
  const app = new Hono();
  app.route('/', createRoutes());
  app.use('/*', serveStatic({ root: './static' }));
  serve({ fetch: app.fetch, hostname: ADDR, port: PORT }, (info) => {
    console.log(`auto-dev listening on http://${info.address}:${info.port}`);
  });
}
