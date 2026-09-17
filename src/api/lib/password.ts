import { argon2idAsync } from '@noble/hashes/argon2.js';

/**
 * Password hashing.
 *
 * Current algorithm: **Argon2id**, the OWASP first choice. It is memory-hard, so
 * an attacker's parallelism is bounded by memory bandwidth rather than arithmetic
 * — which is the weakness of PBKDF2, where a GPU can test thousands of guesses at
 * once because each needs almost no memory.
 *
 * Implemented with `@noble/hashes`, which is pure JavaScript: no WASM binary to
 * ship or instantiate, and — the part that matters most — *the same code runs in
 * the Worker, the test suite and the CLI*, so the three cannot drift on digest
 * format the way the CLI and the Worker did once before.
 *
 * Two formats are supported, and the digest says which it is:
 *
 *   $argon2id$v=19$m=19456,t=2,p=1$<salt-b64url>$<digest-b64url>   ← current
 *   pbkdf2$sha256$100000$<salt-b64url>$<digest-b64url>             ← legacy
 *
 * PBKDF2 verification is retained so existing accounts keep working. A successful
 * sign-in rehashes to Argon2id automatically, so nobody has to reset anything.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Parameters
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * OWASP's recommended Argon2id floor: 19 MiB of memory, 2 iterations, no
 * parallelism. Memory is the parameter that costs an attacker most, so it is set
 * to the recommendation rather than traded away for speed.
 */
export const ARGON2_MEMORY_KIB = 19_456;
export const ARGON2_ITERATIONS = 2;
export const ARGON2_PARALLELISM = 1;
export const ARGON2_VERSION = 0x13;
export const ARGON2_KEY_BYTES = 32;
export const ARGON2_SALT_BYTES = 16;

/**
 * Refuse to derive against a digest demanding more memory than this.
 *
 * A digest is attacker-influenced only in the sense that a corrupted or tampered
 * row could ask for gigabytes; the isolate has 128 MB. Failing closed keeps a bad
 * row a failed sign-in rather than a crashed Worker.
 */
export const MAX_ARGON2_MEMORY_KIB = 65_536;

/** Platform ceiling for the legacy PBKDF2 path, enforced by Cloudflare's WebCrypto. */
export const MAX_PBKDF2_ITERATIONS = 100_000;

/** Work factor applied to new PBKDF2 digests. Only used by the legacy verifier. */
export const PASSWORD_ITERATIONS = 100_000;

/* ────────────────────────────────────────────────────────────────────────────
 * Encoding helpers
 * ──────────────────────────────────────────────────────────────────────────── */

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

/**
 * Constant-time comparison.
 *
 * Uses Cloudflare's non-standard `crypto.subtle.timingSafeEqual` rather than
 * hand-rolling the loop. It is a documented Workers extension, and a
 * security-critical primitive is better taken from the platform than
 * reimplemented — a hand-written comparison is exactly where a timing leak hides.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;

  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?(left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView): boolean;
  };

  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(toArrayBuffer(a), toArrayBuffer(b));
  }

  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= (a[i] as number) ^ (b[i] as number);
  }
  return difference === 0;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Argon2id
 * ──────────────────────────────────────────────────────────────────────────── */

async function deriveArgon2(
  password: string,
  salt: Uint8Array,
  params: { memoryKiB: number; iterations: number; parallelism: number; version: number },
): Promise<Uint8Array> {
  return argon2idAsync(new TextEncoder().encode(password), salt, {
    t: params.iterations,
    m: params.memoryKiB,
    p: params.parallelism,
    version: params.version,
    dkLen: ARGON2_KEY_BYTES,
    // Bounded so a hostile digest cannot ask for the whole isolate.
    maxmem: Math.max(params.memoryKiB * 2, 1024) * 1024,
  });
}

function encodeArgon2(salt: Uint8Array, digest: Uint8Array): string {
  return [
    '',
    'argon2id',
    `v=${ARGON2_VERSION}`,
    `m=${ARGON2_MEMORY_KIB},t=${ARGON2_ITERATIONS},p=${ARGON2_PARALLELISM}`,
    bytesToBase64Url(salt),
    bytesToBase64Url(digest),
  ].join('$');
}

/* ────────────────────────────────────────────────────────────────────────────
 * Digests
 * ──────────────────────────────────────────────────────────────────────────── */

interface Argon2Digest {
  kind: 'argon2id';
  version: number;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: Uint8Array;
  expected: Uint8Array;
}

interface Pbkdf2Digest {
  kind: 'pbkdf2';
  iterations: number;
  salt: Uint8Array;
  expected: Uint8Array;
}

export type ParsedDigest = Argon2Digest | Pbkdf2Digest;

function parseArgon2(stored: string): Argon2Digest | null {
  // ['', 'argon2id', 'v=19', 'm=19456,t=2,p=1', salt, digest]
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[1] !== 'argon2id') return null;

  const version = Number.parseInt((parts[2] ?? '').replace('v=', ''), 10);
  const params = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(parts[3] ?? '');
  if (!params) return null;

  const memoryKiB = Number.parseInt(params[1] as string, 10);
  const iterations = Number.parseInt(params[2] as string, 10);
  const parallelism = Number.parseInt(params[3] as string, 10);

  if (![version, memoryKiB, iterations, parallelism].every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }

  try {
    return {
      kind: 'argon2id',
      version,
      memoryKiB,
      iterations,
      parallelism,
      salt: base64UrlToBytes(parts[4] as string),
      expected: base64UrlToBytes(parts[5] as string),
    };
  } catch {
    return null;
  }
}

function parsePbkdf2(stored: string): Pbkdf2Digest | null {
  const parts = stored.split('$');
  if (parts.length !== 5) return null;

  const [algorithm, digest, iterationsRaw, saltRaw, expectedRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (algorithm !== 'pbkdf2' || digest !== 'sha256') return null;

  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return null;

  try {
    return {
      kind: 'pbkdf2',
      iterations,
      salt: base64UrlToBytes(saltRaw),
      expected: base64UrlToBytes(expectedRaw),
    };
  } catch {
    return null;
  }
}

/** Splits a stored digest, or returns null when it is unrecognised or corrupt. */
export function parsePasswordHash(stored: string): ParsedDigest | null {
  if (stored.startsWith('$argon2id$')) return parseArgon2(stored);
  if (stored.startsWith('pbkdf2$')) return parsePbkdf2(stored);
  return null;
}

/**
 * A syntactically valid digest that no password will ever produce.
 *
 * The parameters match the current ones on purpose: verifying an unknown account
 * against this must cost the same as verifying a real password, or the
 * unknown-account path returns measurably faster and sign-in becomes an
 * account-existence oracle. Built from the constants so it cannot drift.
 */
export const DUMMY_PASSWORD_HASH = encodeArgon2(
  new Uint8Array(ARGON2_SALT_BYTES).fill(0x5a),
  new Uint8Array(ARGON2_KEY_BYTES).fill(0xa5),
);

/** True when a stored digest should be upgraded on the next successful sign-in. */
export function needsRehash(stored: string): boolean {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  if (parsed.kind !== 'argon2id') return true;

  return (
    parsed.memoryKiB !== ARGON2_MEMORY_KIB ||
    parsed.iterations !== ARGON2_ITERATIONS ||
    parsed.parallelism !== ARGON2_PARALLELISM ||
    parsed.version !== ARGON2_VERSION
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Public API
 * ──────────────────────────────────────────────────────────────────────────── */

/** Hashes a plaintext password for storage in `users.password_hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(ARGON2_SALT_BYTES));
  const digest = await deriveArgon2(password, salt, {
    memoryKiB: ARGON2_MEMORY_KIB,
    iterations: ARGON2_ITERATIONS,
    parallelism: ARGON2_PARALLELISM,
    version: ARGON2_VERSION,
  });

  return encodeArgon2(salt, digest);
}

/** Legacy PBKDF2 derivation, for verifying digests created before the migration. */
async function derivePbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(new TextEncoder().encode(password)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toArrayBuffer(salt), iterations },
    baseKey,
    256,
  );

  return new Uint8Array(bits);
}

/**
 * Verifies a plaintext password against a stored digest.
 *
 * Returns false — never throws — for malformed digests, unrecognised algorithms,
 * and digests whose cost parameters this runtime cannot honour. A corrupt or
 * over-strength row must fail closed, not surface as a 500.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;

  try {
    if (parsed.kind === 'argon2id') {
      if (parsed.memoryKiB > MAX_ARGON2_MEMORY_KIB) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            message: 'password digest requires more memory than the isolate allows',
            memoryKiB: parsed.memoryKiB,
            max: MAX_ARGON2_MEMORY_KIB,
          }),
        );
        return false;
      }

      const actual = await deriveArgon2(password, parsed.salt, {
        memoryKiB: parsed.memoryKiB,
        iterations: parsed.iterations,
        parallelism: parsed.parallelism,
        version: parsed.version,
      });

      return timingSafeEqual(actual, parsed.expected);
    }

    if (parsed.iterations > MAX_PBKDF2_ITERATIONS) {
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

    const actual = await derivePbkdf2(password, parsed.salt, parsed.iterations);
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
