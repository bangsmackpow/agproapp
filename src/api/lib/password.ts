/**
 * Password hashing on the edge.
 *
 * PBKDF2-HMAC-SHA256 via WebCrypto — no native dependency, available in every
 * Workers isolate. Encoded as a self-describing string so the work factor and
 * salt travel with the digest and can be raised later without invalidating
 * existing credentials:
 *
 *   pbkdf2$sha256$100000$<salt-b64url>$<digest-b64url>
 *
 * WORK FACTOR — READ BEFORE CHANGING
 * ──────────────────────────────────
 * Cloudflare's WebCrypto rejects PBKDF2 iteration counts above 100,000:
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 *   supported (requested 210000).
 *
 * Local `workerd` (miniflare) does not enforce the same ceiling, so a value that
 * passes every local test can still fail in production. 100,000 is therefore
 * both our work factor and a hard platform ceiling; raising it requires
 * `MAX_PBKDF2_ITERATIONS` to be revisited against the deployed runtime, not just
 * against the test suite.
 *
 * Because the digest is self-describing, a future runtime that permits more
 * iterations can be migrated to without invalidating stored passwords — see
 * `needsRehash`.
 */

const ALGORITHM = 'PBKDF2';
const DIGEST = 'SHA-256';

/** Platform ceiling. Exceeding this throws in the deployed Workers runtime. */
export const MAX_PBKDF2_ITERATIONS = 100_000;

/** Work factor applied to new passwords. */
export const PASSWORD_ITERATIONS = 100_000;

const SALT_BYTES = 16;
const KEY_BITS = 256;

/** Copies a view into a standalone ArrayBuffer, sidestepping typed-array generic friction. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const padding = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(new TextEncoder().encode(password)),
    ALGORITHM,
    false,
    ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    { name: ALGORITHM, hash: DIGEST, salt: toArrayBuffer(salt), iterations },
    baseKey,
    KEY_BITS,
  );

  return new Uint8Array(bits);
}

/**
 * Constant-time comparison.
 *
 * Uses Cloudflare's non-standard `crypto.subtle.timingSafeEqual` rather than
 * hand-rolling the loop. It is a documented Workers extension, and a
 * security-critical primitive is better taken from the platform than
 * reimplemented — a hand-written comparison is exactly where a timing leak hides.
 *
 * Lengths are checked first because the platform helper is not specified for
 * inputs of differing length, and unequal lengths must not be compared at all.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;

  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?(left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView): boolean;
  };

  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(toArrayBuffer(a), toArrayBuffer(b));
  }

  // Fallback for any runtime that predates the extension. Still constant-time.
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= (a[i] as number) ^ (b[i] as number);
  }
  return difference === 0;
}

/** Hashes a plaintext password for storage in `users.password_hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const digest = await derive(password, salt, PASSWORD_ITERATIONS);
  return [
    'pbkdf2',
    DIGEST.toLowerCase().replace('-', ''),
    PASSWORD_ITERATIONS,
    bytesToBase64Url(salt),
    bytesToBase64Url(digest),
  ].join('$');
}

/**
 * A syntactically valid digest that no password will ever produce.
 *
 * Verifying an unknown account against this keeps the failure path's cost equal
 * to a real verification. The work factor is derived from PASSWORD_ITERATIONS
 * rather than written out, because a dummy digest that skips derivation would
 * make the unknown-account path measurably faster and turn sign-in into an
 * account-existence oracle.
 */
export const DUMMY_PASSWORD_HASH = [
  'pbkdf2',
  DIGEST.toLowerCase().replace('-', ''),
  PASSWORD_ITERATIONS,
  bytesToBase64Url(new Uint8Array(SALT_BYTES).fill(0x5a)),
  bytesToBase64Url(new Uint8Array(KEY_BITS / 8).fill(0xa5)),
].join('$');

interface ParsedDigest {  iterations: number;
  salt: Uint8Array;
  expected: Uint8Array;
}

/** Splits a stored digest, or returns null when it is unrecognised or corrupt. */
export function parsePasswordHash(stored: string): ParsedDigest | null {
  const parts = stored.split('$');
  if (parts.length !== 5) return null;

  const [algorithm, digest, iterationsRaw, saltRaw, expectedRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (algorithm !== 'pbkdf2' || digest !== DIGEST.toLowerCase().replace('-', '')) return null;

  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return null;

  try {
    return {
      iterations,
      salt: base64UrlToBytes(saltRaw),
      expected: base64UrlToBytes(expectedRaw),
    };
  } catch {
    return null;
  }
}

/**
 * True when a stored digest was produced with a work factor other than the
 * current one, and should be transparently upgraded on the next successful
 * sign-in.
 */
export function needsRehash(stored: string): boolean {
  const parsed = parsePasswordHash(stored);
  return parsed !== null && parsed.iterations !== PASSWORD_ITERATIONS;
}

/**
 * Verifies a plaintext password against a stored digest.
 *
 * Returns false — never throws — for malformed digests, unrecognised
 * algorithms, and digests whose work factor this runtime cannot compute. A
 * corrupt or over-strength row must fail closed, not surface as a 500.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;

  if (parsed.iterations > MAX_PBKDF2_ITERATIONS) {
    // Diagnosable server-side; the caller only ever sees a failed sign-in.
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'password digest uses an unsupported iteration count',
        iterations: parsed.iterations,
        max: MAX_PBKDF2_ITERATIONS,
      }),
    );
    return false;
  }

  try {
    const actual = await derive(password, parsed.salt, parsed.iterations);
    return timingSafeEqual(actual, parsed.expected);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'password verification failed during derivation',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}
