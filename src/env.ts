/**
 * Worker bindings and environment.
 *
 * `Cloudflare.Env` is generated from `wrangler.toml` by `wrangler types`
 * (worker-configuration.d.ts), so bindings cannot drift from the config. Only
 * values that exist solely as secrets are added here.
 *
 * Note there is no session-signing secret: sessions are opaque 256-bit random
 * tokens stored as SHA-256 digests, so there is nothing to sign.
 */
export type Env = Cloudflare.Env & {
  /** Transactional mail provider key (Resend). Set with `wrangler secret put`. */
  readonly MAIL_PROVIDER_API_KEY?: string;
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
