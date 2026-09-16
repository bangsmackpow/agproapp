import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration.
 *
 * `drizzle-kit generate` only needs `schema` + `out`, so it works offline with
 * no credentials. `drizzle-kit studio` / `push` talk to the remote D1 over HTTP
 * and therefore require the environment variables below (see .dev.vars.example):
 *
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_DATABASE_ID
 *   CLOUDFLARE_D1_TOKEN
 */
export default defineConfig({
  dialect: 'sqlite',
  driver: 'd1-http',
  schema: './src/db/schema.ts',
  out: './migrations',
  verbose: true,
  strict: true,
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
    databaseId: process.env.CLOUDFLARE_DATABASE_ID ?? '',
    token: process.env.CLOUDFLARE_D1_TOKEN ?? '',
  },
});
