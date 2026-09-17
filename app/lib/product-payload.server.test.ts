import { describe, expect, it } from 'vitest';

import { parseProductForm } from './product-payload.server';

/**
 * The parser's contract is that an **absent** field means "leave it alone", not
 * "clear it".
 *
 * That distinction is what makes it safe to hide a field from the form. When the
 * product form was slimmed down, nine inputs stopped rendering; had the parser
 * sent a value for each of them anyway, every save would have wiped the stored
 * values — and `isRegulatedSeed` being one of them would have quietly disarmed
 * the seed-compliance gate.
 *
 * Checkboxes need their own mechanism to be expressible at all, which is what the
 * paired hidden input is for: see the note in product-payload.server.ts.
 */

/** FormData from ordered pairs, so a key can appear more than once. */
function form(...entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

const ITEM = (): [string, string][] => [
  ['sku', 'CHEM-X'],
  ['name', 'Test'],
];

describe('parseProductForm — absent means unchanged', () => {
  it('omits text fields that are not in the form', () => {
    const payload = parseProductForm(form(...ITEM()));

    expect(payload.sku).toBe('CHEM-X');
    // No longer rendered, so never submitted, so must not reach the payload.
    expect(payload).not.toHaveProperty('category');
    expect(payload).not.toHaveProperty('packageSize');
    expect(payload).not.toHaveProperty('brand');
  });

  it('omits blank text fields rather than sending an empty string', () => {
    const payload = parseProductForm(form(...ITEM(), ['notes', '   ']));

    expect(payload).not.toHaveProperty('notes');
  });

  it('omits checkboxes that are not in the form at all', () => {
    // The regression this file exists for. A control the form no longer renders
    // must not be reset.
    const payload = parseProductForm(form(...ITEM()));

    expect(payload).not.toHaveProperty('isRegulatedSeed');
    expect(payload).not.toHaveProperty('isSerialized');
    expect(payload).not.toHaveProperty('taxable');
  });

  it('omits state restrictions when the field is absent, rather than clearing them', () => {
    // `.split('')` on an empty string yields [] rather than undefined, so this
    // needed its own guard or every save would empty the list.
    const payload = parseProductForm(form(...ITEM()));

    expect(payload).not.toHaveProperty('stateRestrictions');
  });
});

describe('parseProductForm — checkboxes', () => {
  it('reads an unticked box as false, from the paired hidden value', () => {
    const payload = parseProductForm(form(...ITEM(), ['taxable', 'off']));

    expect(payload.taxable).toBe(false);
  });

  it('reads a ticked box as true', () => {
    const payload = parseProductForm(form(...ITEM(), ['taxable', 'off'], ['taxable', 'on']));

    expect(payload.taxable).toBe(true);
  });

  it('takes the last value, so the real checkbox wins over the hidden one', () => {
    // Browsers submit the hidden input first because it is first in the markup.
    // Reading the first value would make every box look unticked.
    const ticked = parseProductForm(form(...ITEM(), ['isRegulatedSeed', 'off'], ['isRegulatedSeed', 'on']));
    expect(ticked.isRegulatedSeed).toBe(true);

    const unticked = parseProductForm(form(...ITEM(), ['isRegulatedSeed', 'off']));
    expect(unticked.isRegulatedSeed).toBe(false);
  });
});

describe('parseProductForm — field mapping', () => {
  it('parses state restrictions when present', () => {
    const payload = parseProductForm(form(...ITEM(), ['stateRestrictions', 'ak, ca, hi']));

    expect(payload.stateRestrictions).toEqual(['AK', 'CA', 'HI']);
  });

  it('accepts an empty restriction field as an explicit clear', () => {
    const payload = parseProductForm(form(...ITEM(), ['stateRestrictions', '']));

    expect(payload.stateRestrictions).toEqual([]);
  });

  it('carries the description through', () => {
    const payload = parseProductForm(
      form(...ITEM(), ['description', 'Post-emergent for broadleaf']),
    );

    expect(payload.description).toBe('Post-emergent for broadleaf');
  });

  it('maps the Vendor input onto the manufacturer column', () => {
    const payload = parseProductForm(form(...ITEM(), ['manufacturer', 'Bayer']));

    expect(payload.manufacturer).toBe('Bayer');
  });

  it('converts dollar inputs to integer cents', () => {
    const payload = parseProductForm(
      form(...ITEM(), ['defaultCost', '14.77'], ['carryPrice', '19.99']),
    );

    expect(payload.defaultCostCents).toBe(1477);
    expect(payload.carryPriceCents).toBe(1999);
  });
});
