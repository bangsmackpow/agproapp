import { env as workerEnv } from 'cloudflare:workers';
import { hc } from 'hono/client';
import { redirect } from 'react-router';

import { createApp, type ApiRoutes } from '../../src/api/app';
import type { Env } from '../../src/env';
import type { UserRole } from '../../src/shared/enums';
import { can, type Capability } from '../../src/shared/rbac';

/**
 * Server-side bridge to the API.
 *
 * The Hono app runs in the same isolate as the SSR handler, so loaders and
 * actions call it directly rather than over HTTP. That means one implementation of
 * every business rule and no duplicated authorization logic — the UI can only do
 * what the API already permits. The API remains the authority; hiding a control is
 * a convenience, not a control.
 *
 * Two entry points, deliberately:
 *
 *   `apiClient()` — the typed Hono client. Use this. Response shapes are inferred
 *       from the routes, so a screen cannot drift from the API it calls. The first
 *       build hand-declared an interface per screen and they drifted constantly.
 *
 *   `rawApi()` — the untyped escape hatch, kept only where the raw `Response` is
 *       the point, i.e. reading `Set-Cookie` on login and logout.
 */

const apiWorker = createApp();

/** Placeholder ExecutionContext: handlers in this codebase never use waitUntil. */
const noopContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/**
 * Reads the Worker bindings.
 *
 * Bindings come from the `cloudflare:workers` module rather than being threaded
 * through React Router's request context, which keeps that API out of application
 * code entirely.
 */
export function getEnv(_context?: unknown): Env {
  return workerEnv as Env;
}

/** A typed handle on the API that forwards the caller's session cookie. */
export function apiClient(env: Env, request: Request) {
  const origin = new URL(request.url).origin;
  const cookie = request.headers.get('cookie');

  // The base URL is the literal `''`, not `origin`. Hono derives the client's
  // path shape from the *type* of that argument: pass a widened `string` and the
  // path union collapses to `unknown`, which is exactly the silent failure this
  // bridge exists to prevent. Relative paths are resolved against the real origin
  // inside `fetch` instead.
  return hc<ApiRoutes>('', {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (cookie && !headers.has('cookie')) headers.set('cookie', cookie);
      if (init?.body !== undefined && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }

      const url =
        typeof input === 'string' && input.startsWith('/') ? `${origin}${input}` : input;

      return apiWorker.fetch(new Request(url, { ...init, headers }), env, noopContext);
    },
  });
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
  /** Present on some non-2xx responses that still carry domain data. */
  data?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  /** The full response body, so callers can read domain fields on a non-2xx. */
  readonly payload: unknown;

  constructor(status: number, payload: ApiErrorPayload | null, fallback: string) {
    super(payload?.error?.message ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.error?.code ?? 'error';
    this.details = payload?.error?.details;
    this.payload = payload;
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
 * response. The full envelope is returned (`{ data, pagination }` for
 * collections) rather than just `data`, so pagination metadata is not discarded.
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

/**
 * Maps a validation failure onto the fields that caused it.
 *
 * The API returns Zod issues as `{ path, message }`, so a bad EPA number can
 * highlight the EPA input instead of producing one generic banner.
 */
export function toFieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return {};

  const errors: Record<string, string> = {};
  for (const issue of error.details as unknown[]) {
    if (!issue || typeof issue !== 'object') continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof message !== 'string') continue;
    if (path === undefined || path === null) continue;
    errors[String(path)] = message;
  }

  return errors;
}

export interface ActionFailure {
  error: string;
  fieldErrors?: Record<string, string>;
}

/** Builds an action failure, carrying field-level detail when there is any. */
export function actionFailure(error: unknown, fallback: string): ActionFailure {
  const fieldErrors = toFieldErrors(error);
  return {
    error: error instanceof Error ? error.message : fallback,
    ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
  };
}

/** Resolves the session, or null when nobody is signed in. */
export async function getSessionUser(env: Env, request: Request): Promise<SessionUser | null> {
  const response = await rawApi(env, request, '/auth/me');
  if (!response.ok) return null;

  const payload = (await response.json().catch(() => null)) as { user?: SessionUser } | null;
  return payload?.user ?? null;
}

/** Redirects to the login screen when there is no valid session. */
export async function requireUser(env: Env, request: Request): Promise<SessionUser> {
  const user = await getSessionUser(env, request);
  if (!user) {
    const next = new URL(request.url).pathname;
    throw redirect(`/login${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`);
  }
  return user;
}

/**
 * Guards a route by capability, mirroring the API middleware.
 *
 * The API is still the authority — this exists so a user never sees a screen they
 * cannot use, not to replace enforcement.
 */
export function assertCapability(user: SessionUser, capability: Capability): never | void {
  if (!can(user.role, capability)) {
    throw new Response('You do not have access to this area.', { status: 403 });
  }
}
