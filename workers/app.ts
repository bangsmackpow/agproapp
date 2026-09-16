import { createRequestHandler } from 'react-router';
import * as serverBuild from 'virtual:react-router/server-build';

import { createApp } from '../src/api/app';
import type { Env } from '../src/env';

/**
 * The single Worker entry.
 *
 * `/api/*` and `/healthz` are served by the Hono app; everything else is handed
 * to React Router's SSR handler. Both live in the same isolate, so the UI calls
 * the API without a network hop (see app/lib/api.server.ts) and there is exactly
 * one implementation of every business rule.
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
} satisfies ExportedHandler<Env>;
