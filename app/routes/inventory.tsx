import { Form, Link, useActionData, useLoaderData, useSearchParams } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

import {
  Alert,
  Badge,
  CardHeader,
  EmptyRow,
  PageHeader,
  Pagination,
  SortLink,
  Status,
  Table,
  Td,
  Th,
} from '../components/ui';
import { ConfirmButton } from '../components/confirm';
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

const PAGE_SIZE = 50;

/**
 * The catalogue.
 *
 * Scoped to scanning: find the item, read its stock and cost, open it. Creating a
 * product lives on its own screen, because a full form beneath the list competes
 * with the job this screen is for. That is the rule across the app — browse stays
 * plain, and complexity is invited only where someone has chosen a record to work on.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);

  const url = new URL(request.url);
  const type = url.searchParams.get('type') ?? '';
  const q = url.searchParams.get('q') ?? '';
  const sort = url.searchParams.get('sort') ?? 'name';
  const direction = url.searchParams.get('direction') ?? 'asc';
  const offset = Number(url.searchParams.get('offset') ?? 0) || 0;

  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
    sort,
    direction,
  });
  if (type) params.set('type', type);
  if (q) params.set('q', q);

  const [products, lots] = await Promise.all([
    api<ListEnvelope<ProductRow>>(env, request, `/products?${params}`),
    api<ListEnvelope<LotRow>>(env, request, '/inventory/lots?limit=50'),
  ]);

  const productName = new Map(products.data.map((product) => [product.id, product.name]));

  return {
    products: products.data,
    total: products.pagination.total,
    lots: lots.data.map((lot) => ({ ...lot, productName: productName.get(lot.productId) ?? '—' })),
    type,
    sort,
    direction,
    offset,
    pageSize: PAGE_SIZE,
    search: url.search,
    canWrite: can(user.role, 'inventory:write'),
  };
}

/** One shape for every outcome, so the screen can read both fields without a union. */
interface ActionResult {
  ok?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Deactivating is the only mutation this screen performs. Creating and editing
 * moved to the product screens, so the browse route no longer carries a payload
 * it would have to validate.
 */
export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = getEnv(context);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');

  try {
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
  const { products, total, lots, sort, direction, offset, pageSize, search, canWrite } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [params] = useSearchParams();
  const active = params.get('type') ?? '';

  return (
    <>
      <PageHeader
        title="Inventory"
        description={`${total} item${total === 1 ? '' : 's'}`}
        actions={
          canWrite ? (
            <Link
              to="/inventory/new"
              className="inline-flex h-8 items-center rounded-md bg-brand-700 px-3 text-sm font-medium text-white hover:bg-brand-600"
            >
              New product
            </Link>
          ) : (
            <span className="text-xs text-ink-muted">Read-only</span>
          )
        }
      />

      {result?.error ? (
        <div className="mb-3">
          <Alert title={result.error} />
        </div>
      ) : null}
      {result?.ok ? (
        <div className="mb-3">
          <Alert tone="info" title={result.ok} />
        </div>
      ) : null}

      {/* Division filter and search share one line above the table. */}
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <nav aria-label="Filter by division" className="flex items-center gap-3 text-sm">
          <a
            href="/inventory"
            className={
              active === ''
                ? 'border-b-2 border-brand-700 pb-0.5 font-medium text-ink'
                : 'pb-0.5 text-ink-muted hover:text-ink'
            }
          >
            All
          </a>
          {PRODUCT_TYPES.map((option) => (
            <a
              key={option}
              href={`/inventory?type=${option}`}
              className={
                active === option
                  ? 'border-b-2 border-brand-700 pb-0.5 font-medium text-ink capitalize'
                  : 'pb-0.5 text-ink-muted capitalize hover:text-ink'
              }
            >
              {option}
            </a>
          ))}
        </nav>

        <Form method="get" className="ml-auto flex items-center gap-1.5">
          {active ? <input type="hidden" name="type" value={active} /> : null}
          <input
            name="q"
            defaultValue={params.get('q') ?? ''}
            placeholder="Search name, SKU, brand, EPA…"
            aria-label="Search catalogue"
            className="h-7 w-56 rounded-md border border-border bg-white px-2 text-sm placeholder:text-ink-muted focus:border-brand-600 focus:outline-none"
          />
          <button
            type="submit"
            className="h-7 rounded-md border border-border px-2 text-sm text-ink hover:bg-muted"
          >
            Search
          </button>
        </Form>
      </div>

      <div className="rounded-md border border-border">
        <Table>
          <thead>
            <tr>
              <SortLink basePath="/inventory" current={search} field="sku" active={sort === 'sku'} direction={direction}>
                SKU
              </SortLink>
              <SortLink basePath="/inventory" current={search} field="name" active={sort === 'name'} direction={direction}>
                Name
              </SortLink>
              <SortLink basePath="/inventory" current={search} field="type" active={sort === 'type'} direction={direction}>
                Division
              </SortLink>
              <Th>Unit</Th>
              <Th>EPA / regulatory</Th>
              {/* Not sortable: the on-hand figure is the sum of the movement ledger,
                  not a column, so the API does not offer it as a sort key. */}
              <Th className="text-right">On hand</Th>
              <SortLink
                basePath="/inventory"
                current={search}
                field="defaultCostCents"
                active={sort === 'defaultCostCents'}
                direction={direction}
                className="text-right"
              >
                Cost
              </SortLink>
              <Th />
            </tr>
          </thead>
          <tbody>
            {products.length === 0 ? (
              <EmptyRow colSpan={8} message="Nothing in the catalogue matches." />
            ) : (
              products.map((product) => (
                <tr key={product.id} className="hover:bg-muted/40">
                  <Td className="tabular text-ink-muted">{product.sku}</Td>
                  <Td>
                    <Link
                      to={`/inventory/${product.id}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {product.name}
                    </Link>
                    {product.isActive ? null : (
                      <span className="ml-2 inline-block align-middle">
                        <Status>Inactive</Status>
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={TONES[product.type] ?? 'neutral'}>{product.type}</Badge>
                  </Td>
                  <Td className="text-ink-muted">{product.unit}</Td>
                  <Td>
                    {product.epaNumber ? (
                      <span className="tabular">{product.epaNumber}</span>
                    ) : product.isRegulatedSeed ? (
                      <Badge tone="warning">Regulated seed</Badge>
                    ) : product.isSerialized ? (
                      <Badge tone="info">Serialized</Badge>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </Td>
                  <Td className="tabular text-right">
                    {formatNumber(product.quantityOnHand, 3)} {product.baseUnit}
                  </Td>
                  <Td className="tabular text-right">{formatCents(product.defaultCostCents)}</Td>
                  <Td className="text-right">
                    {canWrite ? (
                      <Form method="post" className="inline">
                        <input
                          type="hidden"
                          name="intent"
                          value={product.isActive ? 'deactivate' : 'reactivate'}
                        />
                        <input type="hidden" name="productId" value={product.id} />
                        {product.isActive ? (
                          <ConfirmButton
                            title={`Deactivate ${product.name}?`}
                            description="It disappears from product pickers but stays on every past invoice, program and vendor bill. You can reactivate it later."
                            confirmLabel="Deactivate"
                          >
                            <span className="text-xs text-ink-muted hover:text-ink">Deactivate</span>
                          </ConfirmButton>
                        ) : (
                          <button
                            type="submit"
                            className="text-xs text-ink-muted hover:text-ink"
                          >
                            Reactivate
                          </button>
                        )}
                      </Form>
                    ) : null}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
        <Pagination
          basePath="/inventory"
          current={search}
          total={total}
          limit={pageSize}
          offset={offset}
        />
      </div>

      {/* Secondary to the catalogue: lot and Seed NO. detail for seed audits. */}
      <div className="mt-4 rounded-md border border-border">
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
      </div>
    </>
  );
}
