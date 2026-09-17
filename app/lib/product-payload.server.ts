/**
 * Product form payload parsing, shared by the create and edit screens.
 *
 * One parser rather than two: a second copy would drift, and a product saved from
 * the edit screen would quietly start differing from one saved from the create
 * screen.
 */

/** Cents from a dollars input, or undefined when blank. */
function money(form: FormData, name: string): number | undefined {
  const raw = form.get(name);
  const value = raw === null ? '' : String(raw).trim();
  if (value === '') return undefined;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : undefined;
}

function number(form: FormData, name: string): number | undefined {
  const raw = form.get(name);
  const value = raw === null ? '' : String(raw).trim();
  if (value === '') return undefined;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function text(form: FormData, name: string): string | undefined {
  const raw = form.get(name);
  const value = raw === null ? '' : String(raw).trim();
  return value === '' ? undefined : value;
}

/** Unchecked checkboxes are absent from FormData, so anything else means false. */
const flag = (form: FormData, name: string) => form.get(name) === 'on';

/**
 * Builds the API payload from a submitted product form.
 *
 * Blank fields are dropped rather than sent as empty, so an edit does not wipe
 * values the form did not carry. Checkboxes are always sent, because a boolean is
 * never blank — an unchecked box is a deliberate `false`.
 */
export function parseProductForm(form: FormData): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    sku: text(form, 'sku'),
    name: text(form, 'name'),
    type: text(form, 'type'),
    brand: text(form, 'brand'),
    manufacturer: text(form, 'manufacturer'),
    unit: text(form, 'unit'),
    baseUnitCode: text(form, 'baseUnitCode'),
    packageSize: text(form, 'packageSize'),
    category: text(form, 'category'),
    epaNumber: text(form, 'epaNumber'),
    pesticideType: text(form, 'pesticideType'),
    activeIngredient: text(form, 'activeIngredient'),
    density: number(form, 'density'),
    stateRestrictions: (text(form, 'stateRestrictions') ?? '')
      .split(',')
      .map((code) => code.trim().toUpperCase())
      .filter((code) => code.length === 2),
    isRegulatedSeed: flag(form, 'isRegulatedSeed'),
    seedTraitSystem: text(form, 'seedTraitSystem'),
    isSerialized: flag(form, 'isSerialized'),
    defaultCostCents: money(form, 'defaultCost'),
    markupPercent: number(form, 'markupPercent'),
    financedAppPriceCents: money(form, 'financedAppPrice'),
    cashAppPriceCents: money(form, 'cashAppPrice'),
    carryPriceCents: money(form, 'carryPrice'),
    taxable: flag(form, 'taxable'),
    notes: text(form, 'notes'),
  };

  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}
