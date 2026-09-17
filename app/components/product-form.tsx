import { useState } from 'react';
import { Form } from 'react-router';

import { Button, Field, Input, Select } from './ui';
import { PRODUCT_TYPES } from '../../src/shared/enums';

/**
 * Product create/edit form.
 *
 * Deliberately small. The table carries far more columns than anyone fills in,
 * and a form that shows all of them makes a simple item look like a chore — so
 * this asks only for what identifies an item and how it is counted, and puts the
 * rest behind two disclosures.
 *
 * Anything not rendered here is left untouched on save rather than cleared. That
 * depends on `parseProductForm` treating an absent field as "unchanged", which is
 * why blank values and missing checkboxes are both dropped there instead of being
 * sent as empty.
 */

export interface UnitOption {
  code: string;
  label: string;
  dimension: string;
}

export interface ProductDefaults {
  id?: string;
  sku?: string;
  name?: string;
  description?: string | null;
  type?: string;
  /** Labelled "Vendor" in the UI; the column predates that name. */
  manufacturer?: string | null;
  unit?: string;
  epaNumber?: string | null;
  isRegulatedSeed?: boolean;
  isSerialized?: boolean;
  defaultCostCents?: number | null;
  financedAppPriceCents?: number | null;
  cashAppPriceCents?: number | null;
  carryPriceCents?: number | null;
  taxable?: boolean;
  notes?: string | null;
}

/** Cents to a dollars string for an input, or empty when unset. */
const dollars = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? '' : (cents / 100).toFixed(2);

/** A collapsed section. Contents still submit — a disclosure is not a removal. */
function Disclosure({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="rounded-md border border-border">
      <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold tracking-wide text-ink-muted uppercase select-none">
        {title}
      </summary>
      {children}
    </details>
  );
}

export function ProductForm({
  units,
  product,
  errors,
  submitLabel,
}: {
  units: UnitOption[];
  product?: ProductDefaults;
  errors?: Record<string, string>;
  submitLabel: string;
}) {
  const [type, setType] = useState(product?.type ?? 'chemical');

  return (
    <Form method="post" className="space-y-3 p-3">
      {product?.id ? <input type="hidden" name="productId" value={product.id} /> : null}
      <input type="hidden" name="intent" value={product?.id ? 'update' : 'create'} />

      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
          Item
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="SKU" error={errors?.sku}>
            <Input name="sku" defaultValue={product?.sku ?? ''} required />
          </Field>
          <Field label="Name" error={errors?.name}>
            <Input name="name" defaultValue={product?.name ?? ''} required />
          </Field>

          <div className="sm:col-span-2">
            <Field label="Description" hint="What it is and what it is for. Not printed on invoices.">
              <textarea
                name="description"
                rows={2}
                defaultValue={product?.description ?? ''}
                className="w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm text-ink focus:border-brand-600 focus:outline-none"
              />
            </Field>
          </div>

          <Field label="Division" error={errors?.type}>
            <Select name="type" value={type} onChange={(event) => setType(event.target.value)}>
              {PRODUCT_TYPES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vendor">
            <Input
              name="manufacturer"
              defaultValue={product?.manufacturer ?? ''}
              placeholder="Who it comes from"
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
          Stock
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Unit"
            hint="How stock is counted. Carry sells whole units of it; application draws it down by acreage."
            error={errors?.unit}
          >
            <Select name="unit" defaultValue={product?.unit ?? 'each'}>
              {units.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label} ({option.code}) — {option.dimension}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Cost per unit ($)" hint="The cost basis invoices are priced from">
            <Input
              name="defaultCost"
              type="number"
              step="0.01"
              min="0"
              defaultValue={dollars(product?.defaultCostCents)}
            />
          </Field>
        </div>
      </fieldset>

      <Disclosure title="Pricing">
        <div className="grid gap-3 border-t border-border px-3 py-3 sm:grid-cols-3">
          <Field label="Financed application ($)">
            <Input
              name="financedAppPrice"
              type="number"
              step="0.01"
              min="0"
              defaultValue={dollars(product?.financedAppPriceCents)}
            />
          </Field>
          <Field label="Cash application ($)">
            <Input
              name="cashAppPrice"
              type="number"
              step="0.01"
              min="0"
              defaultValue={dollars(product?.cashAppPriceCents)}
            />
          </Field>
          <Field label="Carry ($)">
            <Input
              name="carryPrice"
              type="number"
              step="0.01"
              min="0"
              defaultValue={dollars(product?.carryPriceCents)}
            />
          </Field>
        </div>
        <p className="border-t border-border px-3 py-2 text-xs text-ink-muted">
          Used when a product is sold on its own. Application programs are priced per acre from
          their own sheet instead.
        </p>
      </Disclosure>

      <Disclosure title="Advanced">
        <div className="grid gap-3 border-t border-border px-3 py-3 sm:grid-cols-2">
          <Field label="EPA number" error={errors?.epaNumber}>
            <Input
              name="epaNumber"
              defaultValue={product?.epaNumber ?? ''}
              placeholder="35915-4-60663"
            />
          </Field>
          <Field label="Notes">
            <Input name="notes" defaultValue={product?.notes ?? ''} />
          </Field>

          <div className="space-y-2 sm:col-span-2">
            {/* Each checkbox is paired with a hidden `off`. An unticked box is not
                submitted at all, which would be indistinguishable from a field the
                form no longer shows — and the parser needs that difference to know
                whether to leave the stored value alone or set it to false. */}
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="hidden" name="isRegulatedSeed" value="off" />
              <input
                type="checkbox"
                name="isRegulatedSeed"
                value="on"
                defaultChecked={product?.isRegulatedSeed ?? false}
              />
              Regulated seed — requires BOL/CMR and Order Number before an invoice can be sent
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="hidden" name="isSerialized" value="off" />
              <input
                type="checkbox"
                name="isSerialized"
                value="on"
                // A drone defaults to serialized; anything else does not.
                defaultChecked={product?.isSerialized ?? type === 'drone'}
              />
              Unit serialized — each one is tracked individually and named at sale
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="hidden" name="taxable" value="off" />
              <input
                type="checkbox"
                name="taxable"
                value="on"
                defaultChecked={product?.taxable ?? true}
              />
              Taxable
            </label>
          </div>
        </div>
      </Disclosure>

      <Button type="submit">{submitLabel}</Button>
    </Form>
  );
}
