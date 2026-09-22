import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { AppEnv } from '../env';
import { errorBody, HttpError } from './lib/http';
import { requestContext } from './middleware';
import { catalogRoutes } from './routes/catalog';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
import { settingsRoutes } from './routes/settings';

/**
 * Assembles the Hono application.
 *
 * Every router is mounted here, so the complete API surface is visible in one
 * place. Authorization is applied per route group rather than centrally: a route
 * with no `requireCapability` is a route with no capability check, which the code
 * review treats as a finding.
 *
 * The router is *returned* rather than mutated so its type carries the mounted
 * paths. That is what lets the UI import `ApiRoutes` and get end-to-end typed
 * responses instead of re-declaring a hand-maintained interface per screen — the
 * duplication that made the first build's loaders drift from the API.
 */
export function createApp() {
  return (
    new Hono<AppEnv>()
      .use('*', requestContext)
      .onError((error, c) => {
        const requestId = c.get('requestId');
        const headers: Record<string, string> = {};
        if (requestId) headers['x-request-id'] = requestId;

        if (error instanceof HttpError) {
          return c.json(
            errorBody(error.code, error.message, error.details),
            error.status as ContentfulStatusCode,
            headers,
          );
        }

        if (error instanceof HTTPException) {
          return c.json(errorBody('http_error', error.message), error.status, headers);
        }

        // Unexpected: log with the request id so the edge log can be correlated.
        console.error(
          JSON.stringify({
            level: 'error',
            requestId: requestId ?? null,
            message: error.message,
            stack: error.stack,
          }),
        );

        return c.json(errorBody('internal_error', 'An unexpected error occurred'), 500, headers);
      })
      .notFound((c) =>
        c.json(
          errorBody('not_found', `No route for ${c.req.method} ${new URL(c.req.url).pathname}`),
          404,
        ),
      )
      .route('/', healthRoutes)
      // Auth handlers return `{ user }`; the UI bridge reads it to resolve a session.
      .route('/api/auth', authRoutes)
      // Mounted at /api/settings: also serves /api/settings/price-tiers and
      // /api/settings/service-rates, which the invoice composer reads.
      .route('/api/settings', settingsRoutes)
      // Mounted at /api: /api/products, /api/inventory/low, /api/vendors.
      .route('/api', catalogRoutes)
  );
}

export type ApiRoutes = ReturnType<typeof createApp>;
