import { and, eq, gte, lt, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { loginAttempts } from '../db/schema';

/**
 * Brute-force protection for sign-in.
 *
 * Counters live in D1, not KV: KV serialises writes to a single key to roughly
 * one per second, and a credential-stuffing run hammers exactly one key.
 *
 * Two windows are enforced — per email and per source IP — because they defend
 * against different things. The per-email window stops a targeted guessing run;
 * the per-IP window stops one host spraying many accounts, which the per-email
 * window would never see.
 *
 * TRADE-OFF, STATED PLAINLY: any per-email lockout is a denial-of-service
 * vector. Somebody who knows a rep's address can deliberately lock them out. The
 * window is deliberately short and self-healing, so the worst case is a short
 * wait rather than a permanent lockout, and the per-IP limit is the tighter of
 * the two. Lockouts are also written to the audit trail so an attack is visible
 * after the fact.
 */

/** Rolling window over which failures are counted. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** Failures against one account address before it is temporarily locked. */
export const MAX_FAILURES_PER_EMAIL = 10;

/** Failures from one source address, across all accounts. */
export const MAX_FAILURES_PER_IP = 50;

/** Attempt rows older than this are pruned opportunistically. */
export const ATTEMPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RateLimitDecision {
  limited: boolean;
  /** Seconds until the oldest counted failure leaves the window. */
  retryAfterSeconds: number;
  /** Which window tripped, for logging. */
  reason?: 'email' | 'ip';
}

const NOT_LIMITED: RateLimitDecision = { limited: false, retryAfterSeconds: 0 };

/**
 * Counts recent failures for one dimension and returns the moment the window
 * starts to clear, so `Retry-After` is accurate rather than always full-length.
 */
async function windowState(
  db: Database,
  dimension: { column: typeof loginAttempts.email | typeof loginAttempts.ipAddress; value: string },
  since: Date,
): Promise<{ failures: number; oldest: Date | null }> {
  const where = and(
    eq(loginAttempts.success, false),
    gte(loginAttempts.createdAt, since),
    eq(dimension.column, dimension.value),
  );

  const [counted, oldest] = await Promise.all([
    db.select({ total: sql<number>`count(*)` }).from(loginAttempts).where(where).get(),
    db
      .select({ createdAt: loginAttempts.createdAt })
      .from(loginAttempts)
      .where(where)
      .orderBy(loginAttempts.createdAt)
      .limit(1)
      .get(),
  ]);

  return { failures: Number(counted?.total ?? 0), oldest: oldest?.createdAt ?? null };
}

function retryAfterSeconds(oldest: Date | null, now: number): number {
  if (!oldest) return Math.ceil(LOGIN_WINDOW_MS / 1000);
  const clearsAt = oldest.getTime() + LOGIN_WINDOW_MS;
  return Math.max(1, Math.ceil((clearsAt - now) / 1000));
}

/**
 * Decides whether a sign-in attempt may proceed.
 *
 * Called before the account lookup, so a limited response is returned whether or
 * not the email exists — rate limiting must not become an account oracle.
 */
export async function checkLoginRateLimit(
  db: Database,
  input: { email: string; ipAddress?: string | null },
  now = Date.now(),
): Promise<RateLimitDecision> {
  const since = new Date(now - LOGIN_WINDOW_MS);

  const emailState = await windowState(
    db,
    { column: loginAttempts.email, value: input.email },
    since,
  );

  if (emailState.failures >= MAX_FAILURES_PER_EMAIL) {
    return {
      limited: true,
      retryAfterSeconds: retryAfterSeconds(emailState.oldest, now),
      reason: 'email',
    };
  }

  if (input.ipAddress) {
    const ipState = await windowState(
      db,
      { column: loginAttempts.ipAddress, value: input.ipAddress },
      since,
    );

    if (ipState.failures >= MAX_FAILURES_PER_IP) {
      return {
        limited: true,
        retryAfterSeconds: retryAfterSeconds(ipState.oldest, now),
        reason: 'ip',
      };
    }
  }

  return NOT_LIMITED;
}

/** Records an attempt. Successes are recorded for audit but never counted. */
export async function recordLoginAttempt(
  db: Database,
  input: {
    email: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    success: boolean;
  },
): Promise<void> {
  await db.insert(loginAttempts).values({
    email: input.email,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    success: input.success,
  });
}

/**
 * Clears an account's recent failures after a successful sign-in, so a user who
 * mistyped a few times is not left part-way to a lockout.
 */
export async function clearLoginFailures(db: Database, email: string): Promise<void> {
  await db
    .delete(loginAttempts)
    .where(
      and(
        eq(loginAttempts.email, email),
        eq(loginAttempts.success, false),
        gte(loginAttempts.createdAt, new Date(Date.now() - LOGIN_WINDOW_MS)),
      ),
    );
}

/**
 * Drops attempts past the retention horizon.
 *
 * Run opportunistically (on a successful sign-in) rather than on a schedule: the
 * volume here is a handful of rows a day, and this keeps the table bounded
 * without adding a cron trigger to the Worker.
 */
export async function pruneLoginAttempts(db: Database): Promise<void> {
  await db
    .delete(loginAttempts)
    .where(lt(loginAttempts.createdAt, new Date(Date.now() - ATTEMPT_RETENTION_MS)));
}
