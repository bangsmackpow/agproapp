import { Form, Link, useActionData, useLoaderData, useSearchParams } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

import { Alert, Badge, Card, CardHeader, EmptyRow, PageHeader, Table, Td, Th } from '../components/ui';
import { ConfirmButton } from '../components/confirm';
import { ProductForm, type UnitOption } from '../components/product-form';
import { actionFailure, api, getEnv, requireUser } from '../lib/api.server';
import { can } from '../../src/shared/rbac';
import { PRODUCT_TYPES } from '../../src/shared/enums';
import { formatCents, formatNumber } from '../lib/utils';

export const meta = () => [{ title: 'Inventory · AG Pro Solutions' }];

interface ProductRow {
  id: string;
  quantityOnHand: number;
  baseUnit: string;
  sku: string;
  name: string;
  type: string;
  brand: string | null;
  unit: string;
  epaNumber: string | null;
  isRegulatedSeed: boolean;
  isSerialized: boolean;
  defaultCostCents: number | null;
  isActive: boolean;
}

interface LotRow {
  id: string;
  productId: string;
  lotNumber: string | null;
  seedNumber: string | null;
  quantityOnHand: number;
  unitCostCents: number | null;
}

interface ListEnvelope<T> {
  data: T[];
  pagination: { total: number };
}

const TONES: Record<string, 'neutral' | 'info' | 'success' | 'warning'> = {
  chemical: 'info',
  seed: 'success',
  drone: 'warning',
  misc: 'neutral',
};

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);

  const type = new URL(request.url).searchParams.get('type') ?? '';
  const query = type ? `&type=${encodeURIComponent(type)}` : '';

  const [products, lots, units] = await Promise.all([
    api<ListEnvelope<ProductRow>>(env, request, `/products?limit=200${query}`),
    api<ListEnvelope<LotRow>>(env, request, '/inventory/lots?limit=50'),
    api<{ data: UnitOption[] }>(env, request, '/units'),
  ]);

  const productName = new Map(products.data.map((product) => [product.id, product.name]));

  return {
    products: products.data,
    total: products.pagination.total,
    lots: lots.data.map((lot) => ({ ...lot, productName: productName.get(lot.productId) ?? '—' })),
    units: units.data,
    type,
    canWrite: can(user.role, 'inventory:write'),
  };
}

/** One shape for every outcome, so the screen can read both fields without a union. */
interface ActionResult {
  ok?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
}

/** Parses the product form, converting dollars to cents and codes to an array. */
export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = getEnv(context);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');

  const text = (name: string): string | undefined => {
    const raw = form.get(name);
    const value = raw === null ? '' : String(raw).trim();
    return value === '' ? undefined : value;
  };
  const number = (name: string): number | undefined => {
    const value = text(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const money = (name: string): number | undefined => {
    const value = number(name);
    return value === undefined ? undefined : Math.round(value * 100);
  };
  const flag = (name: string) => form.get(name) === 'on';

  try {
    if (intent === 'create' || intent === 'update') {
      const payload: Record<string, unknown> = {
        sku: text('sku'),
        name: text('name'),
        type: text('type'),
        brand: text('brand'),
        manufacturer: text('manufacturer'),
        unit: text('unit'),
        baseUnitCode: text('baseUnitCode'),
        packageSize: text('packageSize'),
        category: text('category'),
        epaNumber: text('epaNumber'),
        pesticideType: text('pesticideType'),
        activeIngredient: text('activeIngredient'),
        density: number('density'),
        stateRestrictions: (text('stateRestrictions') ?? '')
          .split(',')
          .map((code) => code.trim().toUpperCase())
          .filter((code) => code.length === 2),
        isRegulatedSeed: flag('isRegulatedSeed'),
        seedTraitSystem: text('seedTraitSystem'),
        isSerialized: flag('isSerialized'),
        defaultCostCents: money('defaultCost'),
        markupPercent: number('markupPercent'),
        financedAppPriceCents: money('financedAppPrice'),
        cashAppPriceCents: money('cashAppPrice'),
        carryPriceCents: money('carryPrice'),
        taxable: flag('taxable'),
        notes: text('notes'),
      };

      // Drop blanks so an update does not wipe a field the form did not carry.
      const cleaned = Object.fromEntries(
        Object.entries(payload).filter(([, value]) => value !== undefined),
      );

      if (intent === 'create') {
        await api(env, request, '/products', { method: 'POST', body: JSON.stringify(cleaned) });
        return { ok: `Created ${payload.name}.` };
      }

      const id = String(form.get('productId') ?? '');
      const result = await api<{ changes?: Record<string, unknown> }>(env, request, `/products/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(cleaned),
      });

      const changed = Object.keys(result.changes ?? {}).length;
      return {
        ok: changed === 0 ? 'Saved, but nothing had changed.' : `Updated ${payload.name}.`,
      };
    }

    if (intent === 'deactivate' || intent === 'reactivate') {
      const id = String(form.get('productId') ?? '');
      await api(env, request, `/products/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: intent === 'reactivate' }),
      });
      return { ok: intent === 'deactivate' ? 'Product deactivated.' : 'Product reactivated.' };
    }

    return { error: 'Unknown action.' };
  } catch (error) {
    return actionFailure(error, 'That action failed.');
  }
}

export default function InventoryRoute() {
  const { products, total, lots, units, canWrite } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [params] = useSearchParams();
  const active = params.get('type') ?? '';

  return (
    <>
      <PageHeader
        title="Inventory"
        description={`${total} item${total === 1 ? '' : 's'} across chemical, seed, drone and misc`}
        actions={
          canWrite ? <Badge tone="success">Write access</Badge> : <Badge tone="warning">Read-only</Badge>
        }
      />

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

      <div className="mb-4 flex flex-wrap gap-2">
        <a
          href="/inventory"
          data-tap
          className={`rounded-md px-3 py-1.5 text-sm ${active === '' ? 'bg-brand-700 text-white' : 'bg-white text-ink ring-1 ring-border'}`}
        >
          All
        </a>
        {PRODUCT_TYPES.map((option) => (
          <a
            key={option}
            href={`/inventory?type=${option}`}
            data-tap
            className={`rounded-md px-3 py-1.5 text-sm capitalize ${active === option ? 'bg-brand-700 text-white' : 'bg-white text-ink ring-1 ring-border'}`}
          >
            {option}
          </a>
        ))}
      </div>

      <div className="grid gap-6 2xl:grid-cols-3">
        <Card className="2xl:col-span-2">
          <CardHeader title="Catalogue" description="Search by name, SKU, brand or EPA number" />
          <Form method="get" className="flex gap-2 border-b border-border p-4">
            <input
              name="q"
              placeholder="Search catalogue…"
              aria-label="Search catalogue"
              className="h-10 w-full rounded-md border border-border bg-white px-3 text-sm"
            />
            <button
              type="submit"
              className="h-10 shrink-0 rounded-md bg-brand-700 px-4 text-sm font-medium text-white"
            >
              Search
            </button>
          </Form>
          <Table>
            <thead>
              <tr>
                <Th>SKU</Th>
                <Th>Name</Th>
                <Th>Division</Th>
                <Th>Unit</Th>
                <Th>EPA / regulatory</Th>
                <Th className="text-right">On hand</Th>
                <Th className="text-right">Cost</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <EmptyRow colSpan={7} message="Nothing in the catalogue matches." />
              ) : (
                products.map((product) => (
                  <tr key={product.id}>
                    <Td className="tabular">{product.sku}</Td>
                    <Td className="font-medium">{product.name}</Td>
                    <Td>
                      <Badge tone={TONES[product.type] ?? 'neutral'}>{product.type}</Badge>
                    </Td>
                    <Td>{product.unit}</Td>
                    <Td>
                      {product.epaNumber ? (
                        <span className="tabular">{product.epaNumber}</span>
                      ) : product.isRegulatedSeed ? (
                        <Badge tone="warning">Regulated seed</Badge>
                      ) : product.isSerialized ? (
                        <Badge tone="info">Serialized</Badge>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td className="tabular text-right">
                      {formatNumber(product.quantityOnHand, 3)} {product.baseUnit}
                    </Td>
                    <Td className="tabular text-right">{formatCents(product.defaultCostCents)}</Td>
                    <Td>
                      <div className="flex items-center justify-end gap-2">
                        <Link
                          className="rounded-md bg-white px-2.5 py-1 text-xs font-medium text-ink ring-1 ring-border"
                          to={`/inventory/${product.id}`}
                        >
                          Open
                        </Link>
                        {canWrite ? (
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value={product.isActive ? 'deactivate' : 'reactivate'}
                            />
                            <input type="hidden" name="productId" value={product.id} />
                            {product.isActive ? (
                              <ConfirmButton
                                size="sm"
                                title={`Deactivate ${product.name}?`}
                                description="It disappears from product pickers but stays on every past invoice, program and vendor bill. You can reactivate it later."
                                confirmLabel="Deactivate"
                              >
                                Deactivate
                              </ConfirmButton>
                            ) : (
                              <button
                                type="submit"
                                className="rounded-md px-2.5 py-1 text-xs font-medium text-brand-700 underline"
                              >
                                Reactivate
                              </button>
                            )}
                          </Form>
                        ) : null}
                      </div>
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardHeader title="Stock lots" description="Lot and Seed NO. drive seed audits" />          <Table>
            <thead>
              <tr>
                <Th>Product</Th>
                <Th>Lot</Th>
                <Th>Seed NO.</Th>
                <Th className="text-right">On hand</Th>
              </tr>
            </thead>
            <tbody>
              {lots.length === 0 ? (
                <EmptyRow colSpan={4} message="No lots recorded." />
              ) : (
                lots.map((lot) => (
                  <tr key={lot.id}>
                    <Td>{lot.productName}</Td>
                    <Td className="tabular">{lot.lotNumber ?? '—'}</Td>
                    <Td className="tabular">{lot.seedNumber ?? '—'}</Td>
                    <Td className="tabular text-right">{formatNumber(lot.quantityOnHand, 3)}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </Card>
      </div>

      {canWrite ? (
        <Card className="mt-6">
          <CardHeader
            title="Add a product"
            description="Sections appear according to the division — a herbicide is asked for an EPA number, a seed is not."
          />
          <ProductForm units={units} submitLabel="Create product" />
        </Card>
      ) : null}
    </>
  );
}
