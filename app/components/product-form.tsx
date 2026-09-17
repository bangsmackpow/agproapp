import { useState } from 'react';
import { Form } from 'react-router';

import { Button, Field, Input, Select } from './ui';
import { PRODUCT_TYPES } from '../../src/shared/enums';

/**
 * Product create/edit form.
 *
 * There are twenty-odd parameters, so rather than one wall of inputs the
 * type-specific sections reveal themselves from the selected type: a herbicide
 * asks for an EPA number, a seed does not, and neither asks for a serial number.
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
  type?: string;
  brand?: string | null;
  manufacturer?: string | null;
  unit?: string;
  baseUnitCode?: string | null;
  packageSize?: string | null;
  category?: string | null;
  epaNumber?: string | null;
  pesticideType?: string | null;
  activeIngredient?: string | null;
  density?: number | null;
  stateRestrictions?: string[] | null;
  isRegulatedSeed?: boolean;
  seedTraitSystem?: string | null;
  isSerialized?: boolean;
  defaultCostCents?: number | null;
  markupPercent?: number | null;
  financedAppPriceCents?: number | null;
  cashAppPriceCents?: number | null;
  carryPriceCents?: number | null;
  taxable?: boolean;
  notes?: string | null;
}

/** Cents to a dollars string for an input, or empty when unset. */
const dollars = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? '' : (cents / 100).toFixed(2);

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
    <FormSections
      units={units}
      product={product}
      errors={errors}
      type={type}
      onTypeChange={setType}
      submitLabel={submitLabel}
    />
  );
}

function FormSections({
  units,
  product,
  errors,
  type,
  onTypeChange,
  submitLabel,
}: {
  units: UnitOption[];
  product?: ProductDefaults;
  errors?: Record<string, string>;
  type: string;
  onTypeChange: (value: string) => void;
  submitLabel: string;
}) {
  const isChemical = type === 'chemical';
  const isSeed = type === 'seed';
  const isDrone = type === 'drone';

  return (
    <Form method="post" className="space-y-4 p-4">
      {product?.id ? <input type="hidden" name="productId" value={product.id} /> : null}
      <input type="hidden" name="intent" value={product?.id ? 'update' : 'create'} />

      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-xs font-medium text-ink-muted">Identity</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="SKU" error={errors?.sku}>
            <Input name="sku" defaultValue={product?.sku ?? ''} required />
          </Field>
          <Field label="Name" error={errors?.name}>
            <Input name="name" defaultValue={product?.name ?? ''} required />
          </Field>
          <Field label="Division" error={errors?.type}>
            <Select name="type" value={type} onChange={(event) => onTypeChange(event.target.value)}>
              {PRODUCT_TYPES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Category">
            <Input name="category" defaultValue={product?.category ?? ''} placeholder="Herbicide" />
          </Field>
          <Field label="Brand">
            <Input name="brand" defaultValue={product?.brand ?? ''} />
          </Field>
          <Field label="Manufacturer">
            <Input name="manufacturer" defaultValue={product?.manufacturer ?? ''} />
          </Field>
          <Field
            label="Stock unit"
            hint="How this product is counted and sold"
            error={errors?.unit}
          >
            <Select name="unit" defaultValue={product?.unit ?? 'gal'}>
              {units.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label} ({option.code})
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Base unit"
            hint="What stock is pooled in. Blank means the stock unit."
            error={errors?.baseUnitCode}
          >
            <Select name="baseUnitCode" defaultValue={product?.baseUnitCode ?? ''}>
              <option value="">Same as stock unit</option>
              {units.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label} ({option.code})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Package size">
            <Input name="packageSize" defaultValue={product?.packageSize ?? ''} placeholder="2x2.5 GAL" />
          </Field>
        </div>
      </fieldset>

      {isChemical ? (
        <fieldset className="rounded-md border border-border p-3">
          <legend className="px-1 text-xs font-medium text-ink-muted">Crop protection</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="EPA number" error={errors?.epaNumber}>
              <Input name="epaNumber" defaultValue={product?.epaNumber ?? ''} placeholder="35915-4-60663" />
            </Field>
            <Field label="Pesticide type">
              <Input name="pesticideType" defaultValue={product?.pesticideType ?? ''} placeholder="Herbicide" />
            </Field>
            <Field label="Cost per stock unit ($)">
              <Input
                name="defaultCost"
                type="number"
                step="0.001"
                min="0"
                defaultValue={dollars(product?.defaultCostCents)}
              />
            </Field>
            <Field label="Density" hint="Used to convert between weight and volume">
              <Input
                name="density"
                type="number"
                step="0.01"
                min="0"
                defaultValue={product?.density ?? ''}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field
                label="State restrictions"
                hint="Comma separated two-letter codes, e.g. AK,CA,HI. Leave blank if unrestricted."
              >
                <Input
                  name="stateRestrictions"
                  defaultValue={(product?.stateRestrictions ?? []).join(',')}
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Active ingredient">
                <Input name="activeIngredient" defaultValue={product?.activeIngredient ?? ''} />
              </Field>
            </div>
          </div>
        </fieldset>
      ) : null}

      {isSeed ? (
        <fieldset className="rounded-md border border-border p-3">
          <legend className="px-1 text-xs font-medium text-ink-muted">Seed</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Trait system">
              <Input name="seedTraitSystem" defaultValue={product?.seedTraitSystem ?? ''} placeholder="E3" />
            </Field>
            <div className="sm:col-span-2">
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  name="isRegulatedSeed"
                  defaultChecked={product?.isRegulatedSeed ?? false}
                />
                Regulated seed — requires BOL/CMR and Order Number before an invoice can be sent
              </label>
            </div>
          </div>
        </fieldset>
      ) : null}

      {isDrone ? (
        <fieldset className="rounded-md border border-border p-3">
          <legend className="px-1 text-xs font-medium text-ink-muted">Drone</legend>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              name="isSerialized"
              defaultChecked={product?.isSerialized ?? true}
            />
            Unit serialized — each machine is tracked individually and named at sale
          </label>
        </fieldset>
      ) : null}

      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-xs font-medium text-ink-muted">Pricing</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Markup %"
            hint="Applied to cost when no tier price is set"
            error={errors?.markupPercent}
          >
            <Input
              name="markupPercent"
              type="number"
              step="0.1"
              min="0"
              defaultValue={product?.markupPercent ?? 10}
            />
          </Field>
          <Field label="Financed application price ($)">
            <Input
              name="financedAppPrice"
              type="number"
              step="0.01"
              min="0"
              defaultValue={dollars(product?.financedAppPriceCents)}
            />
          </Field>
          <Field label="Cash application price ($)">
            <Input
              name="cashAppPrice"
              type="number"
              step="0.01"
              min="0"
              defaultValue={dollars(product?.cashAppPriceCents)}
            />
          </Field>
          <Field label="Carry price ($)">
            <Input
              name="carryPrice"
              type="number"
              step="0.01"
              min="0"
              defaultValue={dollars(product?.carryPriceCents)}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-xs font-medium text-ink-muted">Other</legend>
        <label className="mb-3 flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="taxable" defaultChecked={product?.taxable ?? true} />
          Taxable
        </label>
        <Field label="Notes">
          <Input name="notes" defaultValue={product?.notes ?? ''} />
        </Field>
      </fieldset>

      <Button type="submit" className="w-full">
        {submitLabel}
      </Button>
    </Form>
  );
}
