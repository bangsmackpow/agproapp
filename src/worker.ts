/**
 * Worker entry point.
 *
 * PHASE 1 SCAFFOLD: this exists so `wrangler.toml` is valid and the Worker can
 * be deployed and observed in the Cloudflare dashboard while the schema lands.
 * Phase 2 replaces the router body with the real Hono application mounted at
 * `/api/*`, at which point this file becomes a thin adapter.
 */

export interface Env {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  KV: KVNamespace;
  ENVIRONMENT: string;
  APP_NAME: string;
  APP_REGION: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function health(env: Env): Promise<Response> {
  const startedAt = Date.now();

  let database: 'ok' | 'unavailable' = 'unavailable';
  let databaseError: string | undefined;

  try {
    await env.DB.prepare('SELECT 1 AS ok').first();
    database = 'ok';
  } catch (error) {
    databaseError = error instanceof Error ? error.message : String(error);
  }

  const healthy = database === 'ok';

  return json(
    {
      status: healthy ? 'ok' : 'degraded',
      app: env.APP_NAME,
      environment: env.ENVIRONMENT,
      region: env.APP_REGION,
      phase: 'phase-1 (schema)',
      checks: {
        database,
        ...(databaseError ? { databaseError } : {}),
      },
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    },
    healthy ? 200 : 503,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health' || url.pathname === '/healthz') {
      return health(env);
    }

    return json(
      {
        error: 'not_found',
        message: 'API surface is implemented in Phase 2. See /api/health for status.',
        path: url.pathname,
      },
      404,
    );
  },
} satisfies ExportedHandler<Env>;
