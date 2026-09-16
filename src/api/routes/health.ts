import { Hono, type Context } from 'hono';

import type { AppEnv } from '../../env';

export const healthRoutes = new Hono<AppEnv>();

/**
 * Liveness plus a real D1 round-trip. Reports `degraded` and a 503 rather than a
 * cheerful 200 when the database binding is unreachable, so a broken deploy
 * cannot masquerade as healthy.
 */
async function health(c: Context<AppEnv>): Promise<Response> {
  const startedAt = Date.now();

  let database: 'ok' | 'unavailable' = 'unavailable';
  let databaseError: string | undefined;

  try {
    await c.env.DB.prepare('SELECT 1 AS ok').first();
    database = 'ok';
  } catch (error) {
    databaseError = error instanceof Error ? error.message : String(error);
  }

  const healthy = database === 'ok';

  return c.json(
    {
      status: healthy ? 'ok' : 'degraded',
      app: c.env.APP_NAME,
      environment: c.env.ENVIRONMENT,
      region: c.env.APP_REGION,
      phase: 'phase-2 (hono gateway)',
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

healthRoutes.get('/healthz', health);
healthRoutes.get('/api/health', health);
