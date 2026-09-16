import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';

import { createDb } from '../../db';
import { auditLogs, sessions, users, type User } from '../../db/schema';
import type { AppEnv } from '../../env';
import { badRequest, errorBody, parseJson, unauthorized } from '../lib/http';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../lib/password';
import {
  SESSION_COOKIE_NAME,
  generateSessionToken,
  hashSessionToken,
  sessionExpiry,
  sessionMaxAgeSeconds,
} from '../lib/session';
import { changePasswordSchema, loginSchema } from '../schemas';
import { requireAuth } from '../middleware';
import {
  checkLoginRateLimit,
  clearLoginFailures,
  pruneLoginAttempts,
  recordLoginAttempt,
} from '../../services/login-rate-limit';
import { recordAudit } from '../../services/audit';

export const authRoutes = new Hono<AppEnv>();

/** Human-readable wait for a rate-limited sign-in. */
function formatWait(seconds: number): string {
  if (seconds < 60) return 'less than a minute';
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Strips the password digest before a user object leaves the Worker. */
export function publicUser(user: User) {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

authRoutes.post('/login', async (c) => {
  const { email, password } = await parseJson(c.req.raw, loginSchema);
  const db = createDb(c.env.DB);
  const ipAddress = c.req.header('cf-connecting-ip') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;

  // Checked before the account lookup: a limited response must be returned
  // whether or not the address exists, or rate limiting becomes an oracle for
  // discovering valid accounts.
  const limit = await checkLoginRateLimit(db, { email, ipAddress });

  if (limit.limited) {
    await recordAudit(db, {
      action: 'auth.login_rate_limited',
      entityType: 'user',
      entityId: null,
      metadata: {
        email,
        reason: limit.reason ?? null,
        retryAfterSeconds: limit.retryAfterSeconds,
      },
      ipAddress,
    });

    return c.json(
      errorBody(
        'rate_limited',
        `Too many sign-in attempts. Try again in ${formatWait(limit.retryAfterSeconds)}.`,
      ),
      429,
      { 'retry-after': String(limit.retryAfterSeconds) },
    );
  }

  const user = await db.select().from(users).where(eq(users.email, email)).get();

  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

  if (!user || !user.isActive || !passwordMatches) {
    await recordLoginAttempt(db, { email, ipAddress, userAgent, success: false });
    throw unauthorized('Invalid email or password');
  }

  await recordLoginAttempt(db, { email, ipAddress, userAgent, success: true });
  // A successful sign-in clears the account's recent failures; retention pruning
  // rides along here rather than needing a scheduled trigger.
  await clearLoginFailures(db, email);
  await pruneLoginAttempts(db);

  const token = generateSessionToken();
  const tokenHash = await hashSessionToken(token);
  const now = new Date();

  await db.insert(sessions).values({
    userId: user.id,
    tokenHash,
    expiresAt: sessionExpiry(now),
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  });

  await db
    .update(users)
    .set({ lastLoginAt: now, updatedAt: now })
    .where(eq(users.id, user.id));

  await db.insert(auditLogs).values({
    actorUserId: user.id,
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: c.env.ENVIRONMENT === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: sessionMaxAgeSeconds(),
  });

  return c.json({ user: publicUser(user) });
});

authRoutes.post('/logout', requireAuth, async (c) => {
  const db = createDb(c.env.DB);
  const user = c.get('user');
  const now = new Date();

  await db
    .update(sessions)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(sessions.id, c.get('sessionId')), isNull(sessions.revokedAt)));

  await db.insert(auditLogs).values({
    actorUserId: user.id,
    action: 'auth.logout',
    entityType: 'user',
    entityId: user.id,
  });

  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });

  return c.json({ ok: true });
});

authRoutes.get('/me', requireAuth, (c) => c.json({ user: publicUser(c.get('user')) }));

authRoutes.post('/change-password', requireAuth, async (c) => {
  const { currentPassword, newPassword } = await parseJson(c.req.raw, changePasswordSchema);
  const db = createDb(c.env.DB);
  const current = c.get('user');

  const fresh = await db.select().from(users).where(eq(users.id, current.id)).get();
  if (!fresh) throw unauthorized();

  if (!(await verifyPassword(currentPassword, fresh.passwordHash))) {
    throw badRequest('Current password is incorrect');
  }

  const now = new Date();

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), updatedAt: now })
    .where(eq(users.id, current.id));

  // Changing a password invalidates every other session for that account.
  await db
    .update(sessions)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(sessions.userId, current.id), isNull(sessions.revokedAt)));

  await db.insert(auditLogs).values({
    actorUserId: current.id,
    action: 'auth.password_changed',
    entityType: 'user',
    entityId: current.id,
  });

  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });

  return c.json({ ok: true, sessionsRevoked: true });
});
