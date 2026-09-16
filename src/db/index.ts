import { drizzle } from 'drizzle-orm/d1';

import * as schema from './schema';

/**
 * Creates a Drizzle client bound to the D1 database for a single request.
 *
 * Instantiate per request (it is cheap — no connection pool to manage) rather
 * than caching in module scope, so a stale binding can never leak between
 * requests or between environments.
 *
 *   const db = createDb(env.DB);
 *   const rows = await db.select().from(schema.customers).limit(10);
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Database = ReturnType<typeof createDb>;

export * from './schema';
