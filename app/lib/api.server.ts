import { env as workerEnv } from 'cloudflare:workers';
import { redirect } from 'react-router';

import { createApp } from '../../src/api/app';
import type { Env } from '../../src/env';
import type { UserRole } from '../../src/shared/enums';
import { can, type Permission } from '../../src/shared/rbac';

/**
 * Server-side bridge to the API.
 *
 * The Hono app runs in the same isolate as the SSR handler, so loaders and
 * actions call it directly rather than over HTTP. That means one implementation
 * of every business rule and no duplicated authorisation logic — the UI can only
 * do what the API already permits.
 */

const apiWorker = createApp();

/** Placeholder ExecutionContext: handlers in this codebase never use waitUntil. */
const noopContext = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

/**
 * Reads the Worker bindings.
 *
 * Bindings come from the `cloudflare:workers` module rather than being threaded
 * through React Router's request context, which keeps the RR version's context
 * API out of the application code entirely.
 */
export function getEnv(_context?: unknown): Env {
  return workerEnv as Env;
}

/**
 * Extracts the Set-Cookie header so it can be re-emitted on a redirect.
 *
 * Prefers `getSetCookie()` (which preserves multiple cookies) and falls back to
 * the single-value accessor.
 */
export function extractSetCookie(response: Response): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const list = headers.getSetCookie?.();
  if (list && list.length > 0) return list[0] ?? null;
  return response.headers.get('set-cookie');
}

export interface ApiErrorPayload {
  error?: { code?: string; message?: string; details?: unknown };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, payload: ApiErrorPayload | null, fallback: string) {
    super(payload?.error?.message ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.error?.code ?? 'error';
    this.details = payload?.error?.details;
  }
}

/** Calls the API, forwarding the caller's session cookie. Returns the raw Response. */
export async function rawApi(
  env: Env,
  request: Request,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const origin = new URL(request.url).origin;
  const headers = new Headers(init.headers);

  const cookie = request.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  return apiWorker.fetch(
    new Request(new URL(`/api${path}`, origin), { ...init, headers }),
    env,
    noopContext,
  );
}

/**
 * Calls the API and unwraps the JSON envelope, throwing `ApiError` on a non-2xx
 * response.
 *
 * The full envelope is returned (`{ data, pagination }` for collections) rather
 * than just `data`, so pagination metadata is not silently discarded.
 */
export async function api<T>(
  env: Env,
  request: Request,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await rawApi(env, request, path, init);

  const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;

  if (!response.ok) {
    throw new ApiError(response.status, payload, `Request to ${path} failed`);
  }

  return payload as T;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  phone: string | null;
}

/** Resolves the session, or null when nobody is signed in. */
export async function getSessionUser(env: Env, request: Request): Promise<SessionUser | null> {
  const response = await rawApi(env, request, '/auth/me');
  if (!response.ok) return null;

  const payload = (await response.json().catch(() => null)) as { user?: SessionUser } | null;
  return payload?.user ?? null;
}

/** Redirects to the login screen when there is no valid session. */
export async function requireUser(
  env: Env,
  request: Request,
): Promise<SessionUser> {
  const user = await getSessionUser(env, request);
  if (!user) {
    const next = new URL(request.url).pathname;
    throw redirect(`/login${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`);
  }
  return user;
}

/**
 * Guards a route by permission, mirroring the API middleware.
 *
 * The API is still the authority — this exists so a user never sees a screen
 * they cannot use, not to replace enforcement.
 */
export function assertPermission(user: SessionUser, permission: Permission): void {
  if (!can(user.role, permission)) {
    throw new Response('You do not have access to this area.', { status: 403 });
  }
}
