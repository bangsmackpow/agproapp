import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { AppEnv } from '../env';
import { errorBody, HttpError } from './lib/http';
import { requestContext } from './middleware';
import { auditRoutes } from './routes/audit';
import { authRoutes } from './routes/auth';
import { catalogRoutes } from './routes/catalog';
import { checkRoutes } from './routes/checks';
import { companyRoutes } from './routes/company';
import { customerRoutes } from './routes/customers';
import { healthRoutes } from './routes/health';
import { importRoutes } from './routes/imports';
import { invoiceRoutes } from './routes/invoices';

/**
 * Assembles the Hono application.
 *
 * Every router is mounted here, so the complete API surface is visible in one
 * place. RBAC is applied per route group rather than centrally: a route with no
 * `requirePermission` is a route with no permissions, which the code review
 * checklist treats as a finding.
 */
export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', requestContext);

  app.onError((error, c) => {
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
  });

  app.notFound((c) =>
    c.json(errorBody('not_found', `No route for ${c.req.method} ${new URL(c.req.url).pathname}`), 404),
  );

  app.route('/', healthRoutes);
  app.route('/api/auth', authRoutes);
  app.route('/api/customers', customerRoutes);
  app.route('/api/invoices', invoiceRoutes);
  app.route('/api/checks', checkRoutes);
  app.route('/api/company', companyRoutes);
  app.route('/api/audit', auditRoutes);
  app.route('/api/imports', importRoutes);
  // Mounted at /api: provides /api/products, /api/inventory/*, /api/drone-units, /api/pricing/*
  app.route('/api', catalogRoutes);

  return app;
}
