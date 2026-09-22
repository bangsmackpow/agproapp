import { Hono, type Context } from 'hono';

import type { AppEnv } from '../../env';

/**
 * Liveness plus a real D1 round-trip. Reports `degraded` and a 503 rather than a
 * cheerful 200 when the database binding is unreachable, so a broken deploy
 * cannot masquerade as healthy.
 *
 * The endpoint is unauthenticated, so the driver's error text is logged with the
 * request id and *not* returned: it can name tables, columns, and query
 * fragments, which is a map of the schema handed to anyone who asks.
 */
async function health(c: Context<AppEnv>): Promise<Response> {
  const startedAt = Date.now();

  let database: 'ok' | 'unavailable' = 'unavailable';

  try {
    await c.env.DB.prepare('SELECT 1 AS ok').first();
    database = 'ok';
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'health: database unreachable',
        requestId: c.get('requestId') ?? null,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  const healthy = database === 'ok';

  return c.json(
    {
      status: healthy ? 'ok' : 'degraded',
      app: c.env.APP_NAME,
      environment: c.env.ENVIRONMENT,
      region: c.env.APP_REGION,
      checks: { database },
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    },
    healthy ? 200 : 503,
  );
}

/**
 * Chained rather than mutated.
 *
 * `const app = new Hono(); app.get(...)` leaves `app`'s *type* as the empty
 * schema, because the mutation returns a new type that is thrown away. That is
 * why every loader in the first build hand-declared its own response interface.
 * Chaining from the constructor is what makes `hc<typeof app>` infer anything.
 */
export const healthRoutes = new Hono<AppEnv>()
  .get('/healthz', health)
  .get('/api/health', health);
