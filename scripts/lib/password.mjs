import { randomBytes, pbkdf2Sync } from 'node:crypto';

/**
 * Password hashing for the local CLI scripts.
 *
 * MUST stay byte-compatible with `src/api/lib/password.ts`, which is what the
 * Worker verifies against:
 *
 *   pbkdf2$sha256$100000$<salt base64url>$<digest base64url>
 *
 * The work factor is capped at 100,000: Cloudflare's WebCrypto rejects higher
 * counts at runtime even though Node computes them happily.
 */

export const PASSWORD_ITERATIONS = 100_000;

const KEY_BYTES = 32;
const SALT_BYTES = 16;
const DIGEST = 'sha256';

export function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const digest = pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, KEY_BYTES, DIGEST);

  return [
    'pbkdf2',
    DIGEST,
    PASSWORD_ITERATIONS,
    salt.toString('base64url'),
    digest.toString('base64url'),
  ].join('$');
}

/** Generates a password that satisfies the app's minimum length. */
export function generatePassword() {
  return `smoke-${randomBytes(18).toString('base64url')}`;
}

/** Escapes a value for a single-quoted SQL literal. */
export function sqlText(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
