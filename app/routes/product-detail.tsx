import { Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

import {
  Alert,
  Badge,
  Button,
  CardHeader,
  EmptyRow,
  Field,
  Input,
  PageHeader,
  Status,
  Table,
  Td,
  Th,
  statusTone,
} from '../components/ui';
import { actionFailure, api, getEnv, requireUser } from '../lib/api.server';
import { parseProductForm } from '../lib/product-payload.server';
import { ProductForm, type UnitOption } from '../components/product-form';
import { can } from '../../src/shared/rbac';
import { formatCents, formatDate, formatNumber } from '../lib/utils';

export const meta = () => [{ title: 'Product · AG Pro Solutions' }];

interface Product {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  type: string;
  manufacturer: string | null;
  unit: string;
  baseUnitCode: string | null;
  isActive: boolean;
  isRegulatedSeed: boolean;
  isSerialized: boolean;
  epaNumber: string | null;
  defaultCostCents: number | null;
  financedAppPriceCents: number | null;
  cashAppPriceCents: number | null;
  carryPriceCents: number | null;
  taxable: boolean;
  notes: string | null;
  markupPercent: number;
}

interface Receipt {
  lotId: string | null;
  remaining: number;
  unitCostCents: number | null;
  occurredAt: number;
}

interface Movement {
  id: string;
  movementType: string;
  quantityDelta: number;
  quantityInBase: number;
  unit: string | null;
  unitCostCents: number | null;
  referenceType: string | null;
  referenceId: string | null;
  occurredAt: number;
  note: string | null;
  balanceInBase: number;
}

interface CustomerSales {
  customerId: string;
  customerName: string;
  quantity: number;
  movementCount: number;
  lastSoldAt: number | null;
}

interface Stock {
  baseUnit: string;
  quantityOnHand: number;
  receipts: Receipt[];
  ledger: Movement[];
  salesByCustomer: CustomerSales[];
  totalSold: number;
}

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);

  const [stock, product, units] = await Promise.all([
    api<{ data: Stock }>(env, request, `/products/${params.id}/stock`),
    api<{ data: Product }>(env, request, `/products/${params.id}`),
    api<{ data: UnitOption[] }>(env, request, '/units'),
  ]);

  return {
    stock: stock.data,
    product: product.data,
    units: units.data,
    canWrite: can(user.role, 'inventory:write'),
  };
}

interface ActionResult {
  ok?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
}

export async function action({ request, context, params }: ActionFunctionArgs): Promise<ActionResult> {
  const env = getEnv(context);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const id = params.id as string;

  const number = (name: string): number | undefined => {
    const raw = form.get(name);
    const value = raw === null ? '' : String(raw).trim();
    if (value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  try {
    if (intent === 'receive') {
      const quantity = number('quantity');
      const cost = number('unitCost');
      if (quantity === undefined) return { error: 'Enter a quantity to receive.' };

      await api(env, request, `/products/${id}/receipts`, {
        method: 'POST',
        body: JSON.stringify({
          quantity,
          unit: String(form.get('unit') ?? '').trim() || undefined,
          unitCostCents: cost === undefined ? undefined : Math.round(cost * 100),
          lotNumber: String(form.get('lotNumber') ?? '').trim() || undefined,
          seedNumber: String(form.get('seedNumber') ?? '').trim() || undefined,
          note: String(form.get('note') ?? '').trim() || undefined,
        }),
      });
      return { ok: `Received ${quantity}.` };
    }

    if (intent === 'adjust') {
      const delta = number('delta');
      const reason = String(form.get('reason') ?? '').trim();
      if (delta === undefined) return { error: 'Enter the correction, negative to write off.' };
      if (!reason) return { error: 'A reason is required — it is the point of an adjustment.' };

      await api(env, request, `/products/${id}/adjustments`, {
        method: 'POST',
        body: JSON.stringify({
          delta,
          unit: String(form.get('unit') ?? '').trim() || undefined,
          reason,
        }),
      });
      return { ok: 'Adjustment recorded.' };
    }

    if (intent === 'update') {
      const payload = parseProductForm(form);
      const result = await api<{ changes?: Record<string, unknown> }>(env, request, `/products/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });

      const changed = Object.keys(result.changes ?? {}).length;
      return {
        ok: changed === 0 ? 'Saved, but nothing had changed.' : `Updated ${payload.name ?? 'product'}.`,
      };
    }

    return { error: 'Unknown action.' };
  } catch (error) {
    return actionFailure(error, 'That action failed.');
  }
}

export default function ProductDetailRoute() {
  const { stock, product, units, canWrite } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();

  const unit = stock.baseUnit;

  // Everything below is already in the base unit, so the running total is a plain
  // sum rather than a mix of gallons and ounces.
  let runningTotal = 0;

  return (
    <>
      <PageHeader
        title={product.name}
        description={[
          product.sku,
          product.type,
          product.manufacturer,
          product.epaNumber ? `EPA ${product.epaNumber}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <div className="flex items-center gap-3">
            {product.isActive ? null : <Status tone="danger">Inactive</Status>}
            {product.isRegulatedSeed ? <Badge tone="warning">Regulated seed</Badge> : null}
            <Link className="text-sm text-accent-text underline" to="/inventory">
              All inventory
            </Link>
          </div>
        }
      />

      {product.description ? (
        <p className="mb-3 max-w-3xl text-sm text-ink-muted">{product.description}</p>
      ) : null}

      {result?.error ? (
        <div className="mb-4">
          <Alert title={result.error} />
        </div>
      ) : null}
      {result?.ok ? (
        <div className="mb-4">
          <Alert tone="info" title={result.ok} />
        </div>
      ) : null}

      {stock.quantityOnHand < 0 ? (
        <div className="mb-4">
          <Alert tone="warning" title="Stock is negative.">
            More has been sold than received for this product. That is usually a missing
            receipt rather than a miscount — add one, or adjust with a reason.
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-border px-3 py-2">
          <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">On hand</p>
          <p className="tabular mt-1 text-3xl font-semibold text-ink">
            {formatNumber(stock.quantityOnHand, 3)}{' '}
            <span className="text-base font-normal text-ink-muted">{unit}</span>
          </p>
        </div>
        <div className="rounded-md border border-border px-3 py-2">
          <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">Sold to date</p>
          <p className="tabular mt-1 text-3xl font-semibold text-ink">
            {formatNumber(stock.totalSold, 3)}{' '}
            <span className="text-base font-normal text-ink-muted">{unit}</span>
          </p>
        </div>
        <div className="rounded-md border border-border px-3 py-2">
          <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">Receipts</p>
          <p className="tabular mt-1 text-3xl font-semibold text-ink">{stock.receipts.length}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-3">
        <div className="rounded-md border border-border">
          <CardHeader
            title="Sold to"
            description="Drawn from the stock ledger, so reversals are reflected"
          />
          <Table>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th className="text-right">Quantity</Th>
                <Th className="text-right">Running total</Th>
                <Th className="text-right">Invoices</Th>
                <Th>Last sale</Th>
              </tr>
            </thead>
            <tbody>
              {stock.salesByCustomer.length === 0 ? (
                <EmptyRow colSpan={5} message="Nothing sold yet." />
              ) : (
                stock.salesByCustomer.map((row) => {
                  runningTotal += row.quantity;
                  return (
                    <tr key={row.customerId}>
                      <Td>{row.customerName}</Td>
                      <Td className="tabular text-right">
                        {formatNumber(row.quantity, 3)} {unit}
                      </Td>
                      <Td className="tabular text-right font-medium">
                        {formatNumber(runningTotal, 3)} {unit}
                      </Td>
                      <Td className="tabular text-right">{row.movementCount}</Td>
                      <Td>{formatDate(row.lastSoldAt)}</Td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </Table>
        </div>

        {canWrite ? (
          <div className="space-y-6">
            <div className="rounded-md border border-border">
              <CardHeader title="Receive stock" description="Creates a receipt and moves the pool" />
              <Form method="post" className="space-y-2 p-3">
                <input type="hidden" name="intent" value="receive" />
                <div className="grid grid-cols-2 gap-3">
                  <Field label={`Quantity (${unit})`}>
                    <Input name="quantity" type="number" step="0.001" min="0" required />
                  </Field>
                  <Field label={`Unit cost ($/${unit})`}>
                    <Input name="unitCost" type="number" step="0.001" min="0" />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Lot number">
                    <Input name="lotNumber" placeholder="4G-2027-01" />
                  </Field>
                  <Field label="Seed NO.">
                    <Input name="seedNumber" />
                  </Field>
                </div>
                <input type="hidden" name="unit" value={unit} />
                <Button type="submit" className="w-full" disabled={navigation.state === 'submitting'}>
                  Receive
                </Button>
              </Form>
            </div>

            <div className="rounded-md border border-border">
              <CardHeader
                title="Adjust"
                description="For a count correction or a write-off. The reason is the record."
              />
              <Form method="post" className="space-y-2 p-3">
                <input type="hidden" name="intent" value="adjust" />
                <input type="hidden" name="unit" value={unit} />
                <Field label={`Correction (${unit})`} hint="Negative writes stock off">
                  <Input name="delta" type="number" step="0.001" required />
                </Field>
                <Field label="Reason">
                  <Input name="reason" required placeholder="Annual count" />
                </Field>
                <Button type="submit" variant="secondary" className="w-full">
                  Record adjustment
                </Button>
              </Form>
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-3">
        <div className="rounded-md border border-border">
          <CardHeader
            title="Ledger"
            description="Every movement, append-only. Corrections are new rows, not edits."
          />
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Type</Th>
                <Th className="text-right">Change</Th>
                <Th className="text-right">Balance</Th>
                <Th className="text-right">Unit cost</Th>
                <Th>Note</Th>
              </tr>
            </thead>
            <tbody>
              {stock.ledger.length === 0 ? (
                <EmptyRow colSpan={6} message="No movements yet." />
              ) : (
                [...stock.ledger].reverse().map((movement) => (
                  <tr key={movement.id}>
                    <Td className="whitespace-nowrap">{formatDate(movement.occurredAt)}</Td>
                    <Td>
                      <Status tone={statusTone(movement.movementType)}>{movement.movementType}</Status>
                    </Td>
                    <Td className="tabular text-right">
                      {movement.quantityDelta > 0 ? '+' : ''}
                      {formatNumber(movement.quantityDelta, 3)}
                    </Td>
                    <Td className="tabular text-right">{formatNumber(movement.balanceInBase, 3)}</Td>
                    <Td className="tabular text-right">{formatCents(movement.unitCostCents)}</Td>
                    <Td className="text-xs text-ink-muted">{movement.note ?? '—'}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </div>

        <div className="rounded-md border border-border">
          <CardHeader
            title="Receipts"
            description="Where this stock came from, and what is left on each"
          />
          <Table>
            <thead>
              <tr>
                <Th>Received</Th>
                <Th className="text-right">Remaining</Th>
                <Th className="text-right">Cost</Th>
              </tr>
            </thead>
            <tbody>
              {stock.receipts.length === 0 ? (
                <EmptyRow colSpan={3} message="No receipts." />
              ) : (
                stock.receipts.map((receipt, index) => (
                  <tr key={receipt.lotId ?? index}>
                    <Td>{formatDate(receipt.occurredAt)}</Td>
                    <Td className="tabular text-right">
                      {formatNumber(receipt.remaining, 3)} {unit}
                    </Td>
                    <Td className="tabular text-right">{formatCents(receipt.unitCostCents)}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
          <p className="border-t border-border p-3 text-xs text-ink-muted">
            Sales draw on the oldest receipt first, and the cost that produces is what keeps margin
            honest when a vendor price changes.
          </p>
        </div>
      </div>

      {canWrite ? (
        <div className="mt-3 rounded-md border border-border">
          <CardHeader
            title="Edit product"
            description="Changes are recorded in the audit trail with their previous values."
          />
          <ProductForm
            units={units}
            submitLabel="Save changes"
            errors={result?.fieldErrors}
            product={{
              id: product.id,
              sku: product.sku,
              name: product.name,
              description: product.description,
              type: product.type,
              manufacturer: product.manufacturer,
              unit: product.unit,
              epaNumber: product.epaNumber,
              isRegulatedSeed: product.isRegulatedSeed,
              isSerialized: product.isSerialized,
              defaultCostCents: product.defaultCostCents,
              // Previously omitted, so an existing price was invisible in the edit
              // form — you could not see what you were changing.
              financedAppPriceCents: product.financedAppPriceCents,
              cashAppPriceCents: product.cashAppPriceCents,
              carryPriceCents: product.carryPriceCents,
              taxable: product.taxable,
              notes: product.notes,
            }}
          />
        </div>
      ) : null}
    </>
  );
}
