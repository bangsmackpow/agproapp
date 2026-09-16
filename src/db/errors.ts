/**
 * True when a database error is a unique-constraint violation.
 *
 * Drizzle wraps driver failures in its own `DrizzleQueryError` ("Failed query:
 * …") and attaches the driver error as `cause`, so the message must be searched
 * through the cause chain — checking only the top-level message would silently
 * turn every duplicate-key conflict into a 500.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  const pattern = /unique constraint failed/i;

  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === 'string') {
      if (pattern.test(current)) return true;
    } else if (current instanceof Error) {
      if (pattern.test(current.message)) return true;
    } else if (typeof current === 'object' && 'message' in current) {
      const message = (current as { message?: unknown }).message;
      if (typeof message === 'string' && pattern.test(message)) return true;
    }

    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }

  return false;
}
