import { describe, expect, it } from 'vitest';

import { diffFields } from './audit';

describe('diffFields', () => {
  it('reports only the fields that changed', () => {
    const changes = diffFields(
      { name: 'Xsate', unit: 'gal', sku: 'CHEM-1' },
      { name: 'Xsate', unit: 'oz', sku: 'CHEM-1' },
    );

    expect(changes).toEqual({ unit: { from: 'gal', to: 'oz' } });
  });

  it('captures the old and new value, which is the whole point', () => {
    // This is the shape that answers "who switched this from gallons to ounces".
    const changes = diffFields({ unit: 'gal' }, { unit: 'oz' });
    expect(changes.unit?.from).toBe('gal');
    expect(changes.unit?.to).toBe('oz');
  });

  it('returns nothing when nothing changed', () => {
    expect(diffFields({ name: 'A' }, { name: 'A' })).toEqual({});
  });

  it('iterates the new row, so a partial update reports only what it wrote', () => {
    const changes = diffFields(
      { name: 'A', unit: 'gal', epaNumber: '123' },
      { unit: 'oz' },
    );

    expect(Object.keys(changes)).toEqual(['unit']);
  });

  it('ignores bookkeeping timestamps', () => {
    const changes = diffFields(
      { name: 'A', updatedAt: new Date(1), createdAt: new Date(1) },
      { name: 'A', updatedAt: new Date(2), createdAt: new Date(2) },
    );

    expect(changes).toEqual({});
  });

  it('compares dates by value, not by object identity', () => {
    expect(diffFields({ at: new Date(1000) }, { at: new Date(1000) })).toEqual({});
    expect(diffFields({ at: new Date(1000) }, { at: new Date(2000) }).at).toBeDefined();
  });

  it('compares arrays structurally', () => {
    const same = diffFields(
      { stateRestrictions: ['AK', 'HI'] },
      { stateRestrictions: ['AK', 'HI'] },
    );
    expect(same).toEqual({});

    const changed = diffFields(
      { stateRestrictions: ['AK', 'HI'] },
      { stateRestrictions: ['AK', 'CA', 'HI'] },
    );
    expect(changed.stateRestrictions?.to).toEqual(['AK', 'CA', 'HI']);
  });

  it('treats null and undefined as equivalent, and notices a real change', () => {
    expect(diffFields({ notes: null }, { notes: undefined })).toEqual({});
    expect(diffFields({ notes: null }, { notes: 'hello' }).notes).toEqual({
      from: null,
      to: 'hello',
    });
  });

  it('never writes credential material into the audit log', () => {
    // The audit viewer is readable by an Admin; hashes must not be.
    const changes = diffFields(
      { passwordHash: 'pbkdf2$sha256$100000$old', apiKey: 'sk-live-old' },
      { passwordHash: 'pbkdf2$sha256$100000$new', apiKey: 'sk-live-new' },
    );

    expect(changes.passwordHash).toEqual({ from: '[redacted]', to: '[redacted]' });
    expect(changes.apiKey).toEqual({ from: '[redacted]', to: '[redacted]' });
    expect(JSON.stringify(changes)).not.toContain('pbkdf2');
    expect(JSON.stringify(changes)).not.toContain('sk-live');
  });

  it('handles a created row, where there is no previous state', () => {
    const changes = diffFields(null, { name: 'New product', type: 'chemical' });
    expect(changes.name).toEqual({ from: null, to: 'New product' });
  });

  it('returns nothing when there is no new state', () => {
    expect(diffFields({ name: 'A' }, null)).toEqual({});
    expect(diffFields({ name: 'A' }, undefined)).toEqual({});
  });

  it('honours additional ignored fields', () => {
    const changes = diffFields({ noise: 1, unit: 'gal' }, { noise: 2, unit: 'oz' }, {
      ignore: ['noise'],
    });

    expect(Object.keys(changes)).toEqual(['unit']);
  });
});
