import { randomBytes } from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';

/**
 * Password hashing for the local CLI scripts.
 *
 * MUST stay byte-compatible with `src/api/lib/password.ts`, which is what the
 * Worker verifies against:
 *
 *   $argon2id$v=19$m=19456,t=2,p=1$<salt base64url>$<digest base64url>
 *
 * Both sides now import the same implementation (`@noble/hashes`) with the same
 * parameters, because the two drifted apart once before when each carried its own
 * hand-written derivation — the CLI minted digests the Worker could not verify.
 * Importing rather than reimplementing is what stops that recurring.
 */

export const ARGON2_MEMORY_KIB = 19_456;
export const ARGON2_ITERATIONS = 2;
export const ARGON2_PARALLELISM = 1;
export const ARGON2_VERSION = 0x13;

const KEY_BYTES = 32;
const SALT_BYTES = 16;

export function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const digest = argon2id(password, salt, {
    t: ARGON2_ITERATIONS,
    m: ARGON2_MEMORY_KIB,
    p: ARGON2_PARALLELISM,
    version: ARGON2_VERSION,
    dkLen: KEY_BYTES,
  });

  return [
    '',
    'argon2id',
    `v=${ARGON2_VERSION}`,
    `m=${ARGON2_MEMORY_KIB},t=${ARGON2_ITERATIONS},p=${ARGON2_PARALLELISM}`,
    Buffer.from(salt).toString('base64url'),
    Buffer.from(digest).toString('base64url'),
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
