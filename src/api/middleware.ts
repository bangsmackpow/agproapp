import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';

import { createDb } from '../db';
import { sessions, users, type User } from '../db/schema';
import type { AppEnv } from '../env';
import { can, type Capability } from '../shared/rbac';
import { forbidden, unauthorized } from './lib/http';
import { SESSION_COOKIE_NAME, hashSessionToken } from './lib/session';

/**
 * Attaches a request id for log correlation. Prefers Cloudflare's `cf-ray` so a
 * Worker log line can be matched to the edge request that produced it.
 */
export const requestContext = createMiddleware<AppEnv>(async (c, next) => {
  const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
  c.set('requestId', requestId);

  // Applies to every response, including Hono's own helpers. API responses are
  // per-session and must never be cached.
  c.header('cache-control', 'no-store');

  await next();
  c.header('x-request-id', requestId);
});

/**
 * Resolves the session cookie into a live user.
 *
 * Rejects on any of: missing cookie, unknown token, revoked session, expired
 * session, or deactivated user. Deactivating a user or revoking a session takes
 * effect on the very next request — there is no stateless token to wait out.
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE_NAME);
  if (!token) throw unauthorized();

  const tokenHash = await hashSessionToken(token);
  const db = createDb(c.env.DB);

  const row = await db
    .select({
      sessionId: sessions.id,
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      name: users.name,
      role: users.role,
      phone: users.phone,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
        eq(users.isActive, true),
      ),
    )
    .get();

  if (!row) throw unauthorized('Session expired or revoked');

  const { sessionId, ...user } = row;
  c.set('sessionId', sessionId);
  c.set('user', user as User);

  await next();
});

/**
 * Route guard for a single capability. Must be mounted after `requireAuth`.
 *
 * This is the middleware-side half of the capability map; the UI reads the same
 * map, so a hidden button and a rejected request can never disagree.
 */
export const requireCapability = (capability: Capability) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user');
    if (!user) throw unauthorized();

    if (!can(user.role, capability)) {
      throw forbidden(`Role "${user.role}" may not perform "${capability}"`);
    }

    await next();
  });

/** Convenience guard for endpoints that are Admin-exclusive in their entirety. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get('user');
  if (!user) throw unauthorized();
  if (user.role !== 'admin') throw forbidden('Administrator access required');
  await next();
});

/**
 * The actor for an audit write.
 *
 * `requireAuth` has already run on every route that calls this, so a missing user
 * is a programming error rather than a 401 — and failing here beats silently
 * writing an activity row attributed to nobody, which is the row you cannot
 * interpret when the trail matters.
 */
export function actorOf(c: Context<AppEnv>): { userId: string; ipAddress: string | null } {
  const user = c.get('user');
  if (!user) throw unauthorized();
  return { userId: user.id, ipAddress: c.req.header('cf-connecting-ip') ?? null };
}
