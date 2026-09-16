import { describe, expect, it } from 'vitest';

import {
  hashPassword,
  MAX_PBKDF2_ITERATIONS,
  needsRehash,
  PASSWORD_ITERATIONS,
  parsePasswordHash,
  timingSafeEqual,
  verifyPassword,
} from './password';

const PASSWORD = 'correct horse battery staple';

/**
 * Generated outside the Workers runtime with `node:crypto`:
 *
 *   pbkdf2Sync(password, Buffer.from('0123456789abcdef'), 100000, 32, 'sha256')
 *
 * This is the exact algorithm `scripts/create-user.mjs` uses, so this fixture
 * pins compatibility between the bootstrap CLI and the Worker's verifier — if
 * either side's encoding or work factor drifts, this test fails rather than the
 * first login.
 */
const NODE_GENERATED_HASH =
  'pbkdf2$sha256$100000$MDEyMzQ1Njc4OWFiY2RlZg$CQEF03iMraucElCfobodRqkaFY16F3mxFDIvP9WoJcs';

/**
 * A digest in the same format but with a work factor above the platform ceiling.
 * The literal below was the production failure: hashes were created at 210,000
 * iterations, and Cloudflare's WebCrypto refused to compute them, turning every
 * sign-in into a 500.
 */
const OVER_CAP_HASH =
  'pbkdf2$sha256$210000$MDEyMzQ1Njc4OWFiY2RlZg$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('work factor', () => {
  it('never exceeds the ceiling enforced by the deployed Workers runtime', () => {
    // Cloudflare rejects PBKDF2 above 100,000 iterations at runtime, while local
    // workerd happily computes larger counts. Raising this without re-checking
    // the deployed runtime breaks authentication in production only.
    expect(MAX_PBKDF2_ITERATIONS).toBe(100_000);
    expect(PASSWORD_ITERATIONS).toBeLessThanOrEqual(MAX_PBKDF2_ITERATIONS);
  });
});

describe('hashPassword', () => {
  it('encodes algorithm, iterations and salt with the digest', async () => {
    const hash = await hashPassword(PASSWORD);
    const segments = hash.split('$');

    expect(segments).toHaveLength(5);
    expect(segments[0]).toBe('pbkdf2');
    expect(segments[1]).toBe('sha256');
    expect(segments[2]).toBe(String(PASSWORD_ITERATIONS));
  });

  it('uses a fresh salt every time', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);

    expect(first).not.toBe(second);
    expect(first.split('$')[3]).not.toBe(second.split('$')[3]);
  });

  it('is verifiable by its own verifier', async () => {
    const hash = await hashPassword(PASSWORD);
    await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong password entirely', hash)).resolves.toBe(false);
  });
});

describe('verifyPassword', () => {
  it('accepts a digest produced by the Node bootstrap script', async () => {
    await expect(verifyPassword(PASSWORD, NODE_GENERATED_HASH)).resolves.toBe(true);
  });

  it('rejects a wrong password against the Node-generated digest', async () => {
    await expect(verifyPassword('not the password', NODE_GENERATED_HASH)).resolves.toBe(false);
  });

  it('fails closed — rather than throwing — for an over-strength digest', async () => {
    // Regression guard: this must be a failed sign-in, never an unhandled error.
    await expect(verifyPassword(PASSWORD, OVER_CAP_HASH)).resolves.toBe(false);
  });

  it('returns false for malformed digests instead of throwing', async () => {
    const malformed = [
      '',
      'nonsense',
      'pbkdf2$sha256$100000$onlyfourparts',
      'argon2$sha256$100000$c2FsdA$aGFzaA',
      'pbkdf2$sha512$100000$c2FsdA$aGFzaA',
      'pbkdf2$sha256$notanumber$c2FsdA$aGFzaA',
      'pbkdf2$sha256$0$c2FsdA$aGFzaA',
      'pbkdf2$sha256$100000$!!!not-base64!!!$aGFzaA',
    ];

    for (const value of malformed) {
      await expect(verifyPassword(PASSWORD, value)).resolves.toBe(false);
    }
  });
});

describe('parsePasswordHash / needsRehash', () => {
  it('reports the stored work factor', () => {
    expect(parsePasswordHash(NODE_GENERATED_HASH)?.iterations).toBe(100_000);
    expect(parsePasswordHash(OVER_CAP_HASH)?.iterations).toBe(210_000);
  });

  it('returns null for unusable digests', () => {
    expect(parsePasswordHash('')).toBeNull();
    expect(parsePasswordHash('pbkdf2$sha256$100000$x')).toBeNull();
  });

  it('flags a digest whose work factor differs from the current one', async () => {
    expect(needsRehash(OVER_CAP_HASH)).toBe(true);
    expect(needsRehash(await hashPassword(PASSWORD))).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('compares equal and unequal buffers', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    expect(timingSafeEqual(a, new Uint8Array([1, 2, 3, 4]))).toBe(true);
    expect(timingSafeEqual(a, new Uint8Array([1, 2, 3, 5]))).toBe(false);
  });

  it('returns false for differing lengths rather than reading out of bounds', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
