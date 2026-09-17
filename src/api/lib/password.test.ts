import { describe, expect, it } from 'vitest';

import {
  ARGON2_ITERATIONS,
  ARGON2_MEMORY_KIB,
  ARGON2_PARALLELISM,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  MAX_ARGON2_MEMORY_KIB,
  MAX_PBKDF2_ITERATIONS,
  needsRehash,
  parsePasswordHash,
  timingSafeEqual,
  verifyPassword,
} from './password';

const PASSWORD = 'correct horse battery staple';

/** Narrows a parsed digest to Argon2id, failing the test with a useful message otherwise. */
function expectArgon2(stored: string) {
  const parsed = parsePasswordHash(stored);
  if (parsed?.kind !== 'argon2id') {
    throw new Error(`expected an argon2id digest, got ${parsed ? parsed.kind : 'null'}`);
  }
  return parsed;
}

/**
 * Generated outside the Workers runtime by `scripts/lib/password.mjs`, using a
 * fixed salt of `0123456789abcdef`:
 *
 *   argon2id(password, salt, { t: 2, m: 19456, p: 1, version: 0x13, dkLen: 32 })
 *
 * This pins compatibility between the bootstrap CLI and the Worker's verifier.
 * The two drifted apart once before — the CLI minted PBKDF2 digests with a work
 * factor Cloudflare's WebCrypto refused to compute, so every account it created
 * was un-sign-in-able, and nothing caught it until a real login. If either side's
 * encoding or parameters drift now, this fixture fails instead of a user.
 */
const EXTERNAL_ARGON2_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$gy5SuVm5Z7Vw7keB9se9p87QGcomaseB_S2U1OhTsM0';

/**
 * The legacy format, kept because real accounts still carry it.
 *
 *   pbkdf2Sync(password, Buffer.from('0123456789abcdef'), 100000, 32, 'sha256')
 *
 * Verifying these is the only reason the PBKDF2 path still exists. Each one is
 * replaced by an Argon2id digest on the next successful sign-in.
 */
const LEGACY_PBKDF2_HASH =
  'pbkdf2$sha256$100000$MDEyMzQ1Njc4OWFiY2RlZg$CQEF03iMraucElCfobodRqkaFY16F3mxFDIvP9WoJcs';

/** Same format, work factor above the platform ceiling. This was a production outage. */
const OVER_CAP_PBKDF2_HASH =
  'pbkdf2$sha256$210000$MDEyMzQ1Njc4OWFiY2RlZg$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** Argon2id demanding 128 MiB, which the 128 MB isolate cannot supply. */
const OVER_MEMORY_ARGON2_HASH =
  '$argon2id$v=19$m=131072,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('parameters', () => {
  it('meets the OWASP recommendation for Argon2id', () => {
    // 19 MiB / 2 iterations / 1 lane. Memory is the parameter that costs an
    // attacker most, so it is held at the recommendation rather than traded away.
    expect(ARGON2_MEMORY_KIB).toBe(19_456);
    expect(ARGON2_ITERATIONS).toBe(2);
    expect(ARGON2_PARALLELISM).toBe(1);
  });

  it('keeps the memory ceiling below what the isolate can allocate', () => {
    // A digest asking for more than the isolate has would be an unhandled error
    // on the sign-in path; it must be refused as a failed sign-in instead.
    expect(MAX_ARGON2_MEMORY_KIB).toBeLessThan(128 * 1024);
  });

  it('keeps the legacy PBKDF2 ceiling enforced by Cloudflare', () => {
    expect(MAX_PBKDF2_ITERATIONS).toBe(100_000);
  });
});

describe('hashPassword', () => {
  it('emits a self-describing PHC Argon2id digest', async () => {
    const segments = (await hashPassword(PASSWORD)).split('$');

    expect(segments).toEqual([
      '',
      'argon2id',
      'v=19',
      `m=${ARGON2_MEMORY_KIB},t=${ARGON2_ITERATIONS},p=${ARGON2_PARALLELISM}`,
      expect.any(String),
      expect.any(String),
    ]);
  });

  it('uses a fresh salt every time', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);

    expect(first).not.toBe(second);
    expect(first.split('$')[4]).not.toBe(second.split('$')[4]);
  });

  it('is verifiable by its own verifier', async () => {
    const hash = await hashPassword(PASSWORD);
    await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong password entirely', hash)).resolves.toBe(false);
  });

  it('produces the format the CLI script would have produced', async () => {
    // Same algorithm, same parameters, same encoding — the only difference is the
    // salt, so the two implementations must agree on everything else.
    const hash = await hashPassword(PASSWORD);
    const external = EXTERNAL_ARGON2_HASH;

    expect(hash.split('$').slice(0, 4)).toEqual(external.split('$').slice(0, 4));
    expect(hash.split('$')[4]).toHaveLength(external.split('$')[4]!.length);
    expect(hash.split('$')[5]).toHaveLength(external.split('$')[5]!.length);
  });
});

describe('verifyPassword', () => {
  it('accepts a digest produced outside the Workers runtime', async () => {
    await expect(verifyPassword(PASSWORD, EXTERNAL_ARGON2_HASH)).resolves.toBe(true);
  });

  it('rejects a wrong password against that digest', async () => {
    await expect(verifyPassword('not the password', EXTERNAL_ARGON2_HASH)).resolves.toBe(false);
  });

  it('still accepts the legacy PBKDF2 format', async () => {
    // The migration path depends on this: accounts written before the switch must
    // keep signing in, or the upgrade never happens.
    await expect(verifyPassword(PASSWORD, LEGACY_PBKDF2_HASH)).resolves.toBe(true);
    await expect(verifyPassword('not the password', LEGACY_PBKDF2_HASH)).resolves.toBe(false);
  });

  it('fails closed — rather than throwing — for an over-strength PBKDF2 digest', async () => {
    // Regression guard: this must be a failed sign-in, never an unhandled error.
    await expect(verifyPassword(PASSWORD, OVER_CAP_PBKDF2_HASH)).resolves.toBe(false);
  });

  it('fails closed for an Argon2id digest requiring more memory than the isolate has', async () => {
    await expect(verifyPassword(PASSWORD, OVER_MEMORY_ARGON2_HASH)).resolves.toBe(false);
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
      // Argon2id shapes that must not be mistaken for a usable digest.
      '$argon2id$v=19$m=0,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$aGFzaA',
      '$argon2id$v=19$m=19456$MDEyMzQ1Njc4OWFiY2RlZg$aGFzaA',
      '$argon2i$v=19$m=19456,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$aGFzaA',
      '$argon2id$v=19$m=19456,t=2,p=1$onlyfiveparts',
    ];

    for (const value of malformed) {
      await expect(verifyPassword(PASSWORD, value)).resolves.toBe(false);
    }
  });
});

describe('parsePasswordHash / needsRehash', () => {
  it('reports the algorithm and its parameters', () => {
    const argon2 = expectArgon2(EXTERNAL_ARGON2_HASH);
    expect(argon2.iterations).toBe(ARGON2_ITERATIONS);
    expect(argon2.memoryKiB).toBe(ARGON2_MEMORY_KIB);

    const legacy = parsePasswordHash(LEGACY_PBKDF2_HASH);
    expect(legacy?.kind).toBe('pbkdf2');
    expect(legacy?.iterations).toBe(100_000);
  });

  it('returns null for unusable digests', () => {
    expect(parsePasswordHash('')).toBeNull();
    expect(parsePasswordHash('pbkdf2$sha256$100000$x')).toBeNull();
    expect(parsePasswordHash('$argon2id$nonsense')).toBeNull();
  });

  it('flags the legacy format for upgrade', () => {
    // This is what makes the migration automatic: every PBKDF2 account reports
    // that it needs rehashing, so the next sign-in replaces it.
    expect(needsRehash(LEGACY_PBKDF2_HASH)).toBe(true);
  });

  it('accepts a digest already using the current parameters', async () => {
    expect(needsRehash(await hashPassword(PASSWORD))).toBe(false);
    expect(needsRehash(EXTERNAL_ARGON2_HASH)).toBe(false);
  });

  it('flags Argon2id digests whose parameters no longer match', () => {
    const base = '$argon2id$v=%v$m=%m,t=%t,p=%p$MDEyMzQ1Njc4OWFiY2RlZg$aGFzaA';
    const variant = (overrides: Record<string, string>) =>
      base
        .replace('%v', overrides.v ?? '19')
        .replace('%m', overrides.m ?? String(ARGON2_MEMORY_KIB))
        .replace('%t', overrides.t ?? String(ARGON2_ITERATIONS))
        .replace('%p', overrides.p ?? String(ARGON2_PARALLELISM));

    expect(needsRehash(variant({ m: '8192' }))).toBe(true);
    expect(needsRehash(variant({ t: '1' }))).toBe(true);
    expect(needsRehash(variant({ p: '2' }))).toBe(true);
    expect(needsRehash(variant({ v: '16' }))).toBe(true);
    expect(needsRehash(variant({}))).toBe(false);
  });

  it('leaves unusable digests for the verifier to reject', () => {
    // needsRehash answers "should we upgrade this", not "is this valid". Reporting
    // true for garbage would make the sign-in path try to hash over a bad row.
    expect(needsRehash('nonsense')).toBe(false);
  });
});

describe('DUMMY_PASSWORD_HASH', () => {
  it('uses the current work factor, so the unknown-account path costs the same as a real check', async () => {
    // If this drifted to a work factor the runtime cannot compute, verifyPassword
    // would bail out early and the failure path would become measurably faster —
    // turning sign-in into an account-existence oracle. Matching the real
    // parameters is the entire point of this constant.
    const parsed = expectArgon2(DUMMY_PASSWORD_HASH);
    expect(parsed.memoryKiB).toBe(ARGON2_MEMORY_KIB);
    expect(parsed.iterations).toBe(ARGON2_ITERATIONS);
    expect(needsRehash(DUMMY_PASSWORD_HASH)).toBe(false);
  });

  it('never verifies against any password', async () => {
    await expect(verifyPassword(PASSWORD, DUMMY_PASSWORD_HASH)).resolves.toBe(false);
    await expect(verifyPassword('', DUMMY_PASSWORD_HASH)).resolves.toBe(false);
  });
});

describe('migration', () => {
  it('upgrades a legacy digest to Argon2id while preserving the password', async () => {
    // Mirrors what sign-in does after verifying: rehash with the current
    // algorithm, then confirm the replacement still accepts the same password.
    // The upgrade is only safe if it is lossless, so that is what is asserted.
    await expect(verifyPassword(PASSWORD, LEGACY_PBKDF2_HASH)).resolves.toBe(true);

    const upgraded = await hashPassword(PASSWORD);

    expect(parsePasswordHash(upgraded)?.kind).toBe('argon2id');
    expect(needsRehash(upgraded)).toBe(false);
    await expect(verifyPassword(PASSWORD, upgraded)).resolves.toBe(true);
    await expect(verifyPassword('not the password', upgraded)).resolves.toBe(false);
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
