import '@cloudflare/vitest-pool-workers/types';
import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      /** Injected by vitest.config.ts, read from ./migrations. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
