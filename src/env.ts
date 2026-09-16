/**
 * Worker bindings and environment.
 *
 * `Cloudflare.Env` is generated from `wrangler.toml` by `wrangler types`
 * (worker-configuration.d.ts), so bindings cannot drift from the config. Only
 * values that exist solely as secrets are added here.
 */
export type Env = Cloudflare.Env & {
  /** Session/cookie signing secret. `.dev.vars` locally, `wrangler secret` remotely. */
  readonly SESSION_SECRET?: string;
};

/** Hono environment for authenticated routes. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    requestId: string;
    /** Populated by `requireAuth`. */
    user: import('./db/schema').User;
    sessionId: string;
  };
}
