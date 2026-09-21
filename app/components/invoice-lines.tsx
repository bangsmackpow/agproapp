import { useState } from 'react';

import { Button, Field, Input, Select } from './ui';

/**
 * The invoice line editor.
 *
 * A client component because rows are added and removed as you work, which is
 * state the server has no opinion about. The whole line set is serialised into a
 * hidden field on every render, so the enclosing `<Form>` still submits it as
 * ordinary FormData and the route action stays a plain action.
 *
 * If JavaScript is off the hidden field is simply absent, and the action treats
 * that as a header-only edit — it never drops lines it cannot see.
 */

export type EditorLineType = 'program' | 'product' | 'package' | 'application_fee' | 'misc';

/** A row as the editor holds it: every value a string, so inputs stay controlled. */
export interface EditorLine {
  key: string;
  lineType: EditorLineType;
  programId: string;
  productId: string;
  applicationFeeId: string;
  description: string;
  quantity: string;
  acres: string;
  /** Dollars, as typed. Converted to cents on the way out. */
  unitPrice: string;
  /** Preserved rather than edited: application-fee lines have no picker yet. */
  locked: boolean;
}

/** A line in the shape `invoiceItemInputSchema` expects. */
export interface ApiLine {
  lineType: EditorLineType;
  programId?: string;
  productId?: string;
  applicationFeeId?: string;
  description?: string;
  quantity?: number;
  acres?: number;
  unitPriceCents?: number;
}

interface ProgramOption {
  id: string;
  name: string;
}

interface ProductOption {
  id: string;
  sku: string;
  name: string;
}

const LINE_TYPE_LABELS: Record<EditorLineType, string> = {
  program: 'Application program',
  product: 'Product',
  package: 'Package',
  application_fee: 'Application fee',
  misc: 'Miscellaneous',
};

function numberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function centsOrUndefined(value: string): number | undefined {
  const parsed = numberOrUndefined(value);
  return parsed === undefined ? undefined : Math.round(parsed * 100);
}

/**
 * Serialises editor rows to the API payload.
 *
 * Blank numbers are omitted rather than sent as `0`, so the schema's own
 * "positive" rules produce the error instead of a silently-zeroed line.
 */
export function toApiLines(lines: readonly EditorLine[]): ApiLine[] {
  return lines.map((line) => {
    if (line.lineType === 'program') {
      return {
        lineType: 'program',
        programId: line.programId,
        acres: numberOrUndefined(line.acres),
      };
    }

    if (line.lineType === 'application_fee') {
      return {
        lineType: 'application_fee',
        applicationFeeId: line.applicationFeeId,
        acres: numberOrUndefined(line.acres),
        description: line.description.trim() || undefined,
      };
    }

    if (line.lineType === 'misc') {
      return {
        lineType: 'misc',
        description: line.description.trim(),
        quantity: numberOrUndefined(line.quantity),
        unitPriceCents: centsOrUndefined(line.unitPrice),
      };
    }

    // product and package both price from a product row.
    return {
      lineType: line.lineType,
      productId: line.productId,
      quantity: numberOrUndefined(line.quantity),
      ...(line.unitPrice.trim() === '' ? {} : { unitPriceCents: centsOrUndefined(line.unitPrice) }),
    };
  });
}

function blankLine(lineType: EditorLineType): EditorLine {
  return {
    key: crypto.randomUUID(),
    lineType,
    programId: '',
    productId: '',
    applicationFeeId: '',
    description: '',
    quantity: lineType === 'misc' ? '1' : '1',
    acres: '',
    unitPrice: '',
    locked: false,
  };
}

export function InvoiceLinesEditor({
  initialLines,
  programs,
  products,
}: {
  initialLines: EditorLine[];
  programs: ProgramOption[];
  products: ProductOption[];
}) {
  const [lines, setLines] = useState<EditorLine[]>(initialLines);

  const update = (key: string, patch: Partial<EditorLine>) => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  };

  const remove = (key: string) => {
    setLines((current) => current.filter((line) => line.key !== key));
  };

  const add = (lineType: EditorLineType) => {
    setLines((current) => [...current, blankLine(lineType)]);
  };

  return (
    <div className="space-y-2">
      <input type="hidden" name="items" value={JSON.stringify(toApiLines(lines))} />

      {lines.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-ink-muted">
          No lines. An invoice needs at least one — add one below.
        </p>
      ) : null}

      {lines.map((line, index) => (
        <div key={line.key} className="rounded-md border border-border">
          <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/60 px-3 py-1.5">
            <span className="text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
              Line {index + 1} · {LINE_TYPE_LABELS[line.lineType]}
            </span>
            {line.locked ? (
              <span className="text-[11px] text-ink-muted">Preserved</span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => remove(line.key)}
                aria-label={`Remove line ${index + 1}`}
              >
                Remove
              </Button>
            )}
          </div>

          <div className="grid gap-3 px-3 py-3 sm:grid-cols-2 lg:grid-cols-4">
            {line.lineType === 'program' ? (
              <>
                <Field label="Program">
                  <Select
                    value={line.programId}
                    onChange={(event) => update(line.key, { programId: event.target.value })}
                  >
                    <option value="">Choose a program…</option>
                    {programs.map((program) => (
                      <option key={program.id} value={program.id}>
                        {program.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Acres">
                  <Input
                    type="number"
                    step="0.1"
                    min="0"
                    value={line.acres}
                    onChange={(event) => update(line.key, { acres: event.target.value })}
                  />
                </Field>
              </>
            ) : null}

            {line.lineType === 'product' || line.lineType === 'package' ? (
              <>
                <Field label="Product">
                  <Select
                    value={line.productId}
                    onChange={(event) => update(line.key, { productId: event.target.value })}
                  >
                    <option value="">Choose a product…</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.sku} — {product.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Quantity">
                  <Input
                    type="number"
                    step="1"
                    min="0"
                    value={line.quantity}
                    onChange={(event) => update(line.key, { quantity: event.target.value })}
                  />
                </Field>
                <Field
                  label="Unit price"
                  hint="Blank uses the tier price; a value overrides it"
                >
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={line.unitPrice}
                    onChange={(event) => update(line.key, { unitPrice: event.target.value })}
                  />
                </Field>
              </>
            ) : null}

            {line.lineType === 'application_fee' ? (
              <Field label="Acres">
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  value={line.acres}
                  onChange={(event) => update(line.key, { acres: event.target.value })}
                />
              </Field>
            ) : null}

            {line.lineType === 'misc' ? (
              <>
                <Field label="Description">
                  <Input
                    value={line.description}
                    onChange={(event) => update(line.key, { description: event.target.value })}
                  />
                </Field>
                <Field label="Quantity">
                  <Input
                    type="number"
                    step="1"
                    min="0"
                    value={line.quantity}
                    onChange={(event) => update(line.key, { quantity: event.target.value })}
                  />
                </Field>
                <Field label="Unit price">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={line.unitPrice}
                    onChange={(event) => update(line.key, { unitPrice: event.target.value })}
                  />
                </Field>
              </>
            ) : null}
          </div>
        </div>
      ))}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => add('program')}>
          Add program
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => add('product')}>
          Add product
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => add('misc')}>
          Add misc line
        </Button>
      </div>
    </div>
  );
}
