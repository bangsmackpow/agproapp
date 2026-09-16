/**
 * Password hashing on the edge.
 *
 * PBKDF2-HMAC-SHA256 via WebCrypto — no native dependency, available in every
 * Workers isolate. Encoded as a self-describing string so the iteration count
 * and salt travel with the digest and can be raised later without invalidating
 * existing credentials:
 *
 *   pbkdf2$sha256$210000$<salt-b64url>$<digest-b64url>
 */

const ALGORITHM = 'PBKDF2';
const DIGEST = 'SHA-256';
const ITERATIONS = 210_000;
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

/** Constant-time comparison; never short-circuits on the first differing byte. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= (a[i] as number) ^ (b[i] as number);
  }
  return difference === 0;
}

/** Hashes a plaintext password for storage in `users.password_hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const digest = await derive(password, salt, ITERATIONS);
  return [
    'pbkdf2',
    DIGEST.toLowerCase().replace('-', ''),
    ITERATIONS,
    bytesToBase64Url(salt),
    bytesToBase64Url(digest),
  ].join('$');
}

/**
 * Verifies a plaintext password against a stored digest.
 *
 * Returns false — rather than throwing — for malformed or unrecognised digests,
 * so a corrupt row cannot be distinguished from a wrong password by a caller.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5) return false;

  const [algorithm, digest, iterationsRaw, saltRaw, expectedRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (algorithm !== 'pbkdf2' || digest !== DIGEST.toLowerCase().replace('-', '')) return false;

  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64UrlToBytes(saltRaw);
    expected = base64UrlToBytes(expectedRaw);
  } catch {
    return false;
  }

  const actual = await derive(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}
