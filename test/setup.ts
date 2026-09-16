import { applyD1Migrations, env } from 'cloudflare:test';

// The full schema is applied once per test run.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
