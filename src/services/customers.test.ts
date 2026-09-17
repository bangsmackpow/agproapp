import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { createDb } from '../db';
import { customerSequences } from '../db/schema';
import { allocateCustomerNumber } from './customers';

/**
 * Account numbers are allocated, never supplied.
 *
 * The starting row comes from migration 0005 rather than the reference seed, so
 * these tests rely on migrations alone — which is the point. Invoice numbering
 * depends on a hand-applied seed, and a database that has been migrated but not
 * seeded therefore cannot write an invoice at all.
 */
describe('allocateCustomerNumber', () => {
  beforeEach(async () => {
    const db = createDb(env.DB);
    await db.delete(customerSequences);
    await db.insert(customerSequences).values({ prefix: 'AGP', nextNumber: 57 });
  });

  it('issues the seeded number first, zero-padded to three digits', async () => {
    const db = createDb(env.DB);
    await expect(allocateCustomerNumber(db)).resolves.toBe('AGP-057');
  });

  it('increments by one and never repeats', async () => {
    const db = createDb(env.DB);

    const issued: string[] = [];
    for (let i = 0; i < 5; i += 1) issued.push(await allocateCustomerNumber(db));

    expect(issued).toEqual(['AGP-057', 'AGP-058', 'AGP-059', 'AGP-060', 'AGP-061']);
    expect(new Set(issued).size).toBe(issued.length);
  });

  it('keeps counting past 999 rather than truncating', async () => {
    // padStart only pads; it must not clip a longer number.
    const db = createDb(env.DB);
    await db.update(customerSequences).set({ nextNumber: 1000 });

    await expect(allocateCustomerNumber(db)).resolves.toBe('AGP-1000');
  });

  it('hands out distinct numbers when called concurrently', async () => {
    // The increment and the read are one atomic statement, so parallel callers
    // cannot be given the same number. Resolved together rather than sequentially.
    const db = createDb(env.DB);

    const issued = await Promise.all(
      Array.from({ length: 10 }, () => allocateCustomerNumber(db)),
    );

    expect(new Set(issued).size).toBe(10);
    expect(issued).toContain('AGP-057');
    expect(issued).toContain('AGP-066');
  });

  it('fails loudly if the sequence row is missing', async () => {
    const db = createDb(env.DB);
    await db.delete(customerSequences);

    await expect(allocateCustomerNumber(db)).rejects.toThrow(/sequence/i);
  });
});
