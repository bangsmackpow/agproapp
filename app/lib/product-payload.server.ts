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

/**
 * Checkbox state, or `undefined` when the control is not in the form at all.
 *
 * A checkbox cannot report "off" on its own: an unticked box is simply not
 * submitted, which is indistinguishable from a control the form no longer
 * renders. So every checkbox is paired with a hidden input of the same name
 * carrying `off`, and the *last* value wins — `on` when ticked, `off` when not.
 *
 * No value at all is therefore the only signal that the field is absent, and that
 * must mean "leave the stored value alone". Returning a boolean either way would
 * silently reset a hidden field on every save, which is how hiding
 * `isRegulatedSeed` would disarm the seed-compliance gate.
 */
const flag = (form: FormData, name: string): boolean | undefined => {
  const values = form.getAll(name);
  if (values.length === 0) return undefined;
  return values[values.length - 1] === 'on';
};

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
    description: text(form, 'description'),
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
    // Absent means untouched. `.split()` on an empty string yields `[]` rather
    // than undefined, so without this guard hiding the field would clear every
    // stored restriction on the next save.
    stateRestrictions: form.has('stateRestrictions')
      ? (text(form, 'stateRestrictions') ?? '')
          .split(',')
          .map((code) => code.trim().toUpperCase())
          .filter((code) => code.length === 2)
      : undefined,
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
