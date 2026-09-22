import { createRequestHandler } from 'react-router';
import * as serverBuild from 'virtual:react-router/server-build';

import { createApp } from '../src/api/app';
import { runScheduledTasks } from '../src/services/scheduler';
import type { Env } from '../src/env';

/**
 * The single Worker entry.
 *
 * `/api/*` and `/healthz` are served by the Hono app; everything else is handed
 * to React Router's SSR handler. Both live in the same isolate, so the UI calls
 * the API without a network hop and there is exactly one implementation of every
 * business rule.
 *
 * `scheduled` is the second entry point: the daily housekeeping described in
 * `src/services/scheduler.ts`.
 */

const apiWorker = createApp();

const reactRouterHandler = createRequestHandler(serverBuild, import.meta.env.MODE);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/healthz' || url.pathname.startsWith('/api/')) {
      return apiWorker.fetch(request, env, ctx);
    }

    return reactRouterHandler(request);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // The cron string is passed through only for logging; every registered job
    // runs on every trigger, so adding a job does not mean editing this file.
    ctx.waitUntil(runScheduledTasks(env, undefined, event.cron));
  },
} satisfies ExportedHandler<Env>;
