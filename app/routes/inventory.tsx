import { Form, useLoaderData, useSearchParams } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';

import { Badge, Card, CardHeader, EmptyRow, PageHeader, Table, Td, Th } from '../components/ui';
import { api, getEnv, requireUser } from '../lib/api.server';
import { can } from '../../src/shared/rbac';
import { PRODUCT_TYPES } from '../../src/shared/enums';
import { formatCents, formatNumber } from '../lib/utils';

export const meta = () => [{ title: 'Inventory · AG Pro Solutions' }];

interface ProductRow {
  id: string;
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

  const [products, lots] = await Promise.all([
    api<ListEnvelope<ProductRow>>(env, request, `/products?limit=200${query}`),
    api<ListEnvelope<LotRow>>(env, request, '/inventory/lots?limit=50'),
  ]);

  const productName = new Map(products.data.map((product) => [product.id, product.name]));

  return {
    products: products.data,
    total: products.pagination.total,
    lots: lots.data.map((lot) => ({ ...lot, productName: productName.get(lot.productId) ?? '—' })),
    type,
    canWrite: can(user.role, 'inventory:write'),
  };
}

export default function InventoryRoute() {
  const { products, total, lots, canWrite } = useLoaderData<typeof loader>();
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
                <Th className="text-right">Cost</Th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <EmptyRow colSpan={6} message="Nothing in the catalogue matches." />
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
                    <Td className="tabular text-right">{formatCents(product.defaultCostCents)}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardHeader title="Stock lots" description="Lot and Seed NO. drive seed audits" />
          <Table>
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
    </>
  );
}
