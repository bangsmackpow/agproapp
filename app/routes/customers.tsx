import { Form, Link, useLoaderData, useSearchParams } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';

import {
  EmptyRow,
  PageHeader,
  Pagination,
  SortLink,
  Status,
  Table,
  Td,
  Th,
} from '../components/ui';
import { api, getEnv, requireUser } from '../lib/api.server';
import { can } from '../../src/shared/rbac';

export const meta = () => [{ title: 'Customers · AG Pro Solutions' }];

interface CustomerRow {
  id: string;
  accountNumber: string;
  name: string;
  phone: string | null;
  billCity: string | null;
  billState: string | null;
  pesticideLicenseNumber: string | null;
  isActive: boolean;
}

interface ListEnvelope<T> {
  data: T[];
  pagination: { total: number };
}

const PAGE_SIZE = 50;

/**
 * The account list.
 *
 * Scoped to scanning. Creating a customer and editing one both live on their own
 * screens, so this route has no mutation action at all — the CRM holds far more
 * fields than a list can justify showing.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);

  const url = new URL(request.url);
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
  if (q) params.set('q', q);

  const customers = await api<ListEnvelope<CustomerRow>>(env, request, `/customers?${params}`);

  return {
    customers: customers.data,
    total: customers.pagination.total,
    q,
    sort,
    direction,
    offset,
    pageSize: PAGE_SIZE,
    search: url.search,
    canWrite: can(user.role, 'crm:write'),
  };
}

export default function CustomersRoute() {
  const { customers, total, sort, direction, offset, pageSize, search, canWrite } =
    useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';

  return (
    <>
      <PageHeader
        title="Customers"
        description={`${total} account${total === 1 ? '' : 's'} on file`}
        actions={
          canWrite ? (
            <Link
              to="/customers/new"
              className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-fg hover:bg-accent-hover"
            >
              New customer
            </Link>
          ) : (
            <span className="text-xs text-ink-muted">Read-only</span>
          )
        }
      />

      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        {q ? (
          <p className="text-sm text-ink-muted">
            Results for “{q}”.{' '}
            <a className="text-accent-text underline" href="/customers">
              Clear
            </a>
          </p>
        ) : null}

        <Form method="get" className="ml-auto flex items-center gap-1.5">
          <input
            name="q"
            defaultValue={q}
            placeholder="Search name, account or phone"
            aria-label="Search customers"
            className="h-7 w-56 rounded-md border border-border bg-surface px-2 text-sm placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/25 focus:outline-none"
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
              <SortLink
                basePath="/customers"
                current={search}
                field="accountNumber"
                active={sort === 'accountNumber'}
                direction={direction}
              >
                Account
              </SortLink>
              <SortLink
                basePath="/customers"
                current={search}
                field="name"
                active={sort === 'name'}
                direction={direction}
              >
                Name
              </SortLink>
              <Th>Location</Th>
              <Th>Phone</Th>
              <Th>Pesticide licence</Th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 ? (
              <EmptyRow colSpan={5} message="No customers match." />
            ) : (
              customers.map((customer) => (
                <tr key={customer.id} className="hover:bg-muted/40">
                  <Td className="tabular text-ink-muted">{customer.accountNumber}</Td>
                  <Td>
                    <Link
                      to={`/customers/${customer.id}`}
                      className="font-medium text-accent-text hover:underline"
                    >
                      {customer.name}
                    </Link>
                    {customer.isActive ? null : (
                      <span className="ml-2 inline-block align-middle">
                        <Status tone="danger">Inactive</Status>
                      </span>
                    )}
                  </Td>
                  <Td>
                    {[customer.billCity, customer.billState].filter(Boolean).join(', ') || (
                      <span className="text-ink-muted">—</span>
                    )}
                  </Td>
                  <Td className="tabular">
                    {customer.phone ?? <span className="text-ink-muted">—</span>}
                  </Td>
                  <Td>
                    {customer.pesticideLicenseNumber ? (
                      <span className="tabular">{customer.pesticideLicenseNumber}</span>
                    ) : (
                      <span className="text-ink-muted">Not on file</span>
                    )}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
        <Pagination
          basePath="/customers"
          current={search}
          total={total}
          limit={pageSize}
          offset={offset}
        />
      </div>
    </>
  );
}
