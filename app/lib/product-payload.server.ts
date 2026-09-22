/**
 * Product form → API payload.
 *
 * One parser for create and edit, because the two must agree about what an absent
 * or blank field *means*, and they previously disagreed in ways that wiped data:
 *
 * • **Create** sends only what was filled in. An empty optional field is omitted,
 *   so the column default applies.
 * • **Edit** distinguishes "not on this form" from "cleared". The form always
 *   renders every field, so an empty text input is a deliberate clear and arrives
 *   as `null`; a field the form stopped rendering stays out of the payload and
 *   keeps its stored value.
 *
 * Getting this wrong is silent: hiding an input used to reset the value behind it.
 * Money is dollars in the form and cents in the payload, and never a float all the
 * way through.
 */
export interface ProductFormResult {
  error?: string;
  payload?: Record<string, unknown>;
}

export function parseProductForm(
  form: FormData,
  mode: 'create' | 'edit',
): ProductFormResult {
  const cleared = mode === 'edit';
  const payload: Record<string, unknown> = {};

  const text = (name: string, opts: { required?: boolean; maxLength?: number } = {}) => {
    const raw = form.get(name);
    const value = typeof raw === 'string' ? raw.trim() : '';

    if (!value) {
      if (opts.required) return { error: `${label(name)} is required.` };
      if (cleared) payload[name] = null;
      return {};
    }

    if (opts.maxLength && value.length > opts.maxLength) {
      return { error: `${label(name)} must be ${opts.maxLength} characters or fewer.` };
    }

    payload[name] = value;
    return {};
  };

  const number = (
    name: string,
    opts: { toCents?: boolean; positive?: boolean; required?: boolean } = {},
  ) => {
    const raw = form.get(name);
    const value = typeof raw === 'string' ? raw.trim() : '';

    if (!value) {
      if (opts.required) return { error: `${label(name)} is required.` };
      if (cleared) payload[name] = null;
      return {};
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return { error: `${label(name)} must be a number.` };
    if (opts.positive && parsed <= 0) return { error: `${label(name)} must be greater than zero.` };

    payload[name] = opts.toCents ? Math.round(parsed * 100) : parsed;
    return {};
  };

  const sku = text('sku', { required: true, maxLength: 60 });
  if (sku.error) return sku;
  const name = text('name', { required: true, maxLength: 200 });
  if (name.error) return name;

  const type = form.get('type');
  if (typeof type === 'string' && type) payload.type = type;

  const unit = form.get('unit');
  if (typeof unit === 'string' && unit) payload.unit = unit;

  // Cost is what makes a product invoiceable. Optional to save, required to sell.
  const cost = number('cost', { toCents: true, positive: true });
  if (cost.error) return cost;

  const epa = text('epaNumber', { maxLength: 60 });
  if (epa.error) return epa;

  const description = text('description', { maxLength: 2000 });
  if (description.error) return description;

  const notes = text('notes', { maxLength: 2000 });
  if (notes.error) return notes;

  const vendor = text('vendorId');
  if (vendor.error) return vendor;

  const reorderPoint = number('reorderPoint');
  if (reorderPoint.error) return reorderPoint;

  const reorderQuantity = number('reorderQuantity', { positive: true });
  if (reorderQuantity.error) return reorderQuantity;

  // A checkbox that is not submitted is indistinguishable from one that is absent,
  // so every one is paired with a hidden `off` and read here as a boolean.
  payload.isRegulatedSeed = form.get('isRegulatedSeed') === 'on';

  if (mode === 'edit') {
    payload.isActive = form.get('isActive') === 'on';
  }

  return { payload };
}

const FIELD_LABELS: Record<string, string> = {
  sku: 'SKU',
  name: 'Name',
  cost: 'Cost',
  epaNumber: 'EPA number',
  description: 'Description',
  notes: 'Notes',
  vendorId: 'Vendor',
  reorderPoint: 'Reorder point',
  reorderQuantity: 'Reorder quantity',
};

function label(name: string): string {
  return FIELD_LABELS[name] ?? name;
}
