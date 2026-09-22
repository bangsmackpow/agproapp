import { Form, Link, useLoaderData } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';

import {
  Badge,
  Button,
  EmptyRow,
  Input,
  PageHeader,
  Pagination,
  Select,
  SortLink,
  Status,
  Table,
  Td,
  Th,
} from '../components/ui';
import { apiClient, getEnv, requireUser } from '../lib/api.server';
import { can } from '../../src/shared/rbac';
import { formatCents } from '../lib/utils';

export const meta = () => [{ title: 'Inventory · AG Pro Solutions' }];

const PAGE_SIZE = 50;

/**
 * The catalog, at a glance.
 *
 * The one question this screen must answer without a click is "do I need to order
 * anything", so on-hand quantity and the reorder point sit next to each other and
 * the needs-ordering filter is a tab rather than a hidden query. A product with no
 * cost is called out here too: it exists but cannot be sold, and finding that out
 * at the invoice composer is the worst time to learn it.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);
  const params = new URL(request.url).searchParams;
  const offset = Number(params.get('offset') ?? '0') || 0;

  const query = {
    limit: String(PAGE_SIZE),
    offset: String(offset),
    q: params.get('q') ?? undefined,
    type: (params.get('type') ?? undefined) as
      | 'chemical'
      | 'seed'
      | 'drone'
      | 'other'
      | undefined,
    stock: params.get('stock') === 'low' ? ('low' as const) : undefined,
    sort: (params.get('sort') ?? 'name') as 'name' | 'sku' | 'type' | 'costCents' | 'createdAt',
    direction: (params.get('direction') ?? 'asc') as 'asc' | 'desc',
  };

  const client = apiClient(env, request);
  const [products, low, vendors] = await Promise.all([
    client.api.products.$get({ query }),
    client.api.inventory.low.$get(),
    client.api.vendors.$get(),
  ]);

  const page = await products.json();
  const lowBody = await low.json();

  return {
    user,
    products: page.data ?? [],
    pagination: page.pagination ?? { limit: PAGE_SIZE, offset, total: 0 },
    search: new URL(request.url).searchParams.toString(),
    lowCount: (lowBody.data ?? []).length,
    vendorCount: ((await vendors.json()).data ?? []).length,
    canWrite: can(user.role, 'manageCatalog'),
    active: {
      q: params.get('q') ?? '',
      type: params.get('type') ?? '',
      stock: params.get('stock') ?? '',
      sort: query.sort,
      direction: query.direction,
    },
  };
}

export default function InventoryRoute() {
  const { products, pagination, search, lowCount, vendorCount, canWrite, active, user } =
    useLoaderData<typeof loader>();
  const q = active.q;
  const needing = products.filter((product) => product.needsReorder).length;

  return (
    <>
      <PageHeader
        title="Inventory"
        description={`${pagination.total} item${pagination.total === 1 ? '' : 's'} catalogued · ${vendorCount} vendor${vendorCount === 1 ? '' : 's'}`}
        actions={
          canWrite ? (
            <Link
              to="/inventory/new"
              className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-fg hover:bg-accent-hover"
            >
              New product
            </Link>
          ) : (
            <span className="text-xs text-ink-muted">Read-only</span>
          )
        }
      />

      <nav aria-label="Filter by stock state" className="mb-2 flex items-center gap-3 text-sm">
        <Link
          to="/inventory"
          className={
            active.stock === 'low'
              ? 'pb-0.5 text-ink-muted hover:text-ink'
              : 'border-b-2 border-accent pb-0.5 font-medium text-ink'
          }
        >
          All
        </Link>
        <Link
          to="/inventory?stock=low"
          className={
            active.stock === 'low'
              ? 'border-b-2 border-accent pb-0.5 font-medium text-ink'
              : 'pb-0.5 text-ink-muted hover:text-ink'
          }
        >
          Needs ordering
          {lowCount > 0 ? <span className="ml-1 tabular">({lowCount})</span> : null}
        </Link>
      </nav>

      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        {q ? (
          <p className="text-sm text-ink-muted">
            Results for “{q}”.{' '}
            <Link className="text-accent-text underline" to="/inventory">
              Clear
            </Link>
          </p>
        ) : null}

        <Form method="get" className="ml-auto flex items-center gap-1.5">
          {active.stock === 'low' ? <input type="hidden" name="stock" value="low" /> : null}
          <Input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Name, SKU or EPA number"
            aria-label="Search the catalog"
            className="h-7 w-56"
          />
          <Select name="type" defaultValue={active.type} aria-label="Division" className="h-7 w-32">
            <option value="">Any division</option>
            <option value="chemical">Chemical</option>
            <option value="seed">Seed</option>
            <option value="drone">Drone</option>
            <option value="other">Other</option>
          </Select>
          <Button type="submit" variant="secondary" size="sm">
            Search
          </Button>
        </Form>
      </div>

      <div className="rounded-md border border-border">
        <Table>
          <thead>
            <tr>
              <SortLink basePath="/inventory" current={search} field="name" active={active.sort === 'name'} direction={active.direction}>
                Item
              </SortLink>
              <Th>Division</Th>
              <Th className="text-right">On hand</Th>
              <Th className="text-right">Reorder at</Th>
              <SortLink basePath="/inventory" current={search} field="costCents" active={active.sort === 'costCents'} direction={active.direction} className="text-right">
                Cost
              </SortLink>
              <Th>Vendor</Th>
            </tr>
          </thead>
          <tbody>
            {products.length === 0 ? (
              <EmptyRow
                colSpan={6}
                message={
                  active.stock === 'low'
                    ? 'Nothing needs ordering.'
                    : 'No products yet. Add the first one to get started.'
                }
              />
            ) : (
              products.map((product) => (
                <tr key={product.id} className="hover:bg-muted/40">
                  <Td>
                    <Link to={`/inventory/${product.id}`} className="font-medium text-accent-text hover:underline">
                      {product.name}
                    </Link>
                    <div className="flex items-center gap-2">
                      <span className="tabular text-xs text-ink-muted">{product.sku}</span>
                      {!product.isInvoiceable ? <Badge tone="warning">No cost</Badge> : null}
                      {!product.isActive ? (
                        <span className="text-xs text-ink-muted">inactive</span>
                      ) : null}
                    </div>
                  </Td>
                  <Td className="capitalize text-ink-muted">{product.type}</Td>
                  <Td className="tabular text-right">
                    {product.needsReorder ? (
                      <Status tone="danger">{`${product.quantityOnHand} ${product.unit}`}</Status>
                    ) : (
                      `${product.quantityOnHand} ${product.unit}`
                    )}
                  </Td>
                  <Td className="tabular text-right text-ink-muted">
                    {product.reorderPoint ?? '—'}
                  </Td>
                  <Td className="tabular text-right">
                    {product.costCents === null ? '—' : formatCents(product.costCents)}
                  </Td>
                  <Td className="text-ink-muted">{product.vendorName ?? '—'}</Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>

        {needing > 0 && active.stock !== 'low' ? (
          <p className="border-t border-border px-3 py-1.5 text-xs text-ink-muted">
            {needing} of the {products.length} items on this page are at or below their reorder
            point.
          </p>
        ) : null}

        <Pagination
          basePath="/inventory"
          current={search}
          total={pagination.total}
          limit={pagination.limit}
          offset={pagination.offset}
        />
      </div>

      <p className="mt-2 text-xs text-ink-muted">
        On hand is summed from the stock ledger, never stored, so it cannot drift from the
        movements behind it. Signed in as {user.role}.
      </p>
    </>
  );
}
