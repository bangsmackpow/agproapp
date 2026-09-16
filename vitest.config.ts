import path from 'node:path';

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Tests run inside workerd via the Workers Vitest plugin, so they exercise the
 * real runtime, the real Hono app and a real per-run D1 instance rather than a
 * hand-rolled harness. Migrations are read from ./migrations and applied once in
 * the setup file.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(process.cwd(), 'migrations'));

  return {
    plugins: [
      cloudflareTest({
        // Test the API entry directly, not the combined Worker: the React Router
        // server build is a virtual module that only exists after a Vite build,
        // and the API surface is what needs the runtime coverage.
        main: './src/worker.ts',
        wrangler: { configPath: './wrangler.toml' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
    },
  };
});
