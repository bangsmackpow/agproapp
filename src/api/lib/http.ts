import type { ZodType } from 'zod';

/**
 * Transport-level helpers: a typed error, a JSON responder, and a Zod body
 * parser. Keeping these in one place means every route fails the same way and
 * every error response has the same shape.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, message, 'bad_request', details);

export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, message, 'unauthorized');

export const forbidden = (message = 'Insufficient permissions') =>
  new HttpError(403, message, 'forbidden');

export const notFound = (message = 'Resource not found') =>
  new HttpError(404, message, 'not_found');

export const conflict = (message: string, details?: unknown) =>
  new HttpError(409, message, 'conflict', details);

export const unprocessable = (message: string, details?: unknown) =>
  new HttpError(422, message, 'unprocessable_entity', details);

export function json<T>(body: T, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

/** Formats Zod issues into a compact, client-friendly list. */
function formatIssues(error: { issues: readonly { path: PropertyKey[]; message: string }[] }) {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/**
 * Parses a JSON request body against a Zod schema, throwing a 422 carrying the
 * field-level issues when validation fails.
 */
export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;

  try {
    raw = await request.json();
  } catch {
    throw badRequest('Request body must be valid JSON');
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw unprocessable('Request body failed validation', formatIssues(result.error));
  }

  return result.data;
}

/** Parses and validates query parameters against a Zod schema. */
export function parseQuery<T>(url: URL, schema: ZodType<T>): T {
  const entries: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) entries[key] = value;

  const result = schema.safeParse(entries);
  if (!result.success) {
    throw unprocessable('Query parameters failed validation', formatIssues(result.error));
  }

  return result.data;
}
