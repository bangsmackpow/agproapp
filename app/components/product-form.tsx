import { Field, Input, Select } from './ui';
import { PRODUCT_TYPES, UNITS } from '../../src/shared/enums';

/**
 * The fields a product actually has.
 *
 * The first build's product form asked for roughly twenty of the twenty-eight
 * columns on `products`, including a base unit it could not explain and nine fields
 * nothing ever read. This asks for what the pricing rule and the reorder alert use,
 * plus what the State of Iowa cares about.
 *
 * Rendered inside the caller's `<Form>` so create and edit share one field set and
 * one parser — a divergence between the two is how a hidden input once silently
 * reset a stored value.
 */
export interface ProductFormValues {
  sku?: string;
  name?: string;
  description?: string | null;
  type?: string;
  unit?: string;
  costCents?: number | null;
  epaNumber?: string | null;
  isRegulatedSeed?: boolean;
  reorderPoint?: number | null;
  reorderQuantity?: number | null;
  vendorId?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  chemical: 'Chemical',
  seed: 'Seed',
  drone: 'Drone',
  other: 'Other',
};

export function ProductForm({
  product,
  vendors,
}: {
  product?: ProductFormValues;
  vendors: { id: string; name: string }[];
}) {
  const costDollars =
    product?.costCents !== null && product?.costCents !== undefined
      ? (product.costCents / 100).toFixed(2)
      : '';

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="SKU" hint="Unique; the number on the pallet">
        <Input name="sku" required defaultValue={product?.sku ?? ''} maxLength={60} />
      </Field>

      <Field label="Name">
        <Input name="name" required defaultValue={product?.name ?? ''} maxLength={200} />
      </Field>

      <Field label="Division" hint="Drone is reserved for the future sales line">
        <Select name="type" defaultValue={product?.type ?? 'chemical'}>
          {PRODUCT_TYPES.map((type) => (
            <option key={type} value={type}>
              {TYPE_LABELS[type]}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Unit" hint="Stocked, billed, and rated in this one unit">
        <Select name="unit" defaultValue={product?.unit ?? 'each'}>
          {UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {unit}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Cost"
        hint="Dollars. The sell price is cost × tier. No cost means not invoiceable."
      >
        <Input name="cost" type="number" step="0.01" min="0" defaultValue={costDollars} />
      </Field>

      <Field label="EPA number" hint="Chemicals only; prints on nothing but is asked for">
        <Input name="epaNumber" defaultValue={product?.epaNumber ?? ''} maxLength={60} />
      </Field>

      <Field label="Vendor" hint="Who to order from">
        <Select name="vendorId" defaultValue={product?.vendorId ?? ''}>
          <option value="">—</option>
          {vendors.map((vendor) => (
            <option key={vendor.id} value={vendor.id}>
              {vendor.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Reorder point" hint="Alerts when on hand reaches this">
        <Input
          name="reorderPoint"
          type="number"
          step="0.01"
          min="0"
          defaultValue={product?.reorderPoint ?? ''}
        />
      </Field>

      <Field label="Suggested order quantity" hint="Shown on the reorder list">
        <Input
          name="reorderQuantity"
          type="number"
          step="0.01"
          min="0"
          defaultValue={product?.reorderQuantity ?? ''}
        />
      </Field>

      <div className="sm:col-span-2 lg:col-span-3">
        <Field label="Description" hint="Internal only — invoice lines describe themselves from the name">
          <Textarea name="description" defaultValue={product?.description ?? ''} rows={2} />
        </Field>
      </div>

      <div className="sm:col-span-2 lg:col-span-3">
        <Field label="Notes">
          <Textarea name="notes" defaultValue={product?.notes ?? ''} rows={2} />
        </Field>
      </div>

      <div className="flex flex-wrap items-end gap-4 sm:col-span-2 lg:col-span-3">
        <Checkbox
          name="isRegulatedSeed"
          label="Regulated seed"
          hint="Requires a seed record (BOL/CMR + order + lot) before an invoice can be issued"
          defaultChecked={product?.isRegulatedSeed ?? false}
        />
        {product ? (
          <Checkbox
            name="isActive"
            label="Active"
            hint="Inactive products stay in the ledger but stop being sellable"
            defaultChecked={product.isActive ?? true}
          />
        ) : null}
      </div>
    </div>
  );
}

const CONTROL =
  'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-ink focus:border-accent focus:ring-2 focus:ring-accent/25 focus:outline-none';

function Textarea({
  name,
  defaultValue,
  rows = 3,
}: {
  name: string;
  defaultValue?: string;
  rows?: number;
}) {
  return <textarea name={name} rows={rows} defaultValue={defaultValue} className={CONTROL} />;
}

/**
 * Paired with a hidden `off` input on purpose: an unticked checkbox is *also*
 * absent from FormData, and without the pair the two cases cannot be told apart —
 * which is how hiding a checkbox used to silently reset it.
 */
function Checkbox({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="hidden" name={name} value="off" />
      <input
        type="checkbox"
        name={name}
        value="on"
        defaultChecked={defaultChecked}
        className="mt-0.5 size-4 accent-accent"
      />
      <span>
        <span className="font-medium text-ink">{label}</span>
        {hint ? <span className="block text-xs text-ink-muted">{hint}</span> : null}
      </span>
    </label>
  );
}
