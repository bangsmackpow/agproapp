import { Link, useLoaderData, useSearchParams } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';

import {
  EmptyRow,
  PageHeader,
  Pagination,
  Status,
  Table,
  Td,
  Th,
  statusTone,
} from '../components/ui';
import { api, getEnv, requireUser } from '../lib/api.server';
import { can } from '../../src/shared/rbac';
import { INVOICE_STATUSES } from '../../src/shared/enums';
import { formatCents, formatDate } from '../lib/utils';

export const meta = () => [{ title: 'Invoices · AG Pro Solutions' }];

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  customerName: string;
  status: string;
  issueDate: number;
  totalCents: number;
  balanceCents: number;
}

interface ListEnvelope<T> {
  data: T[];
  pagination: { total: number };
}

const PAGE_SIZE = 50;

/**
 * The invoice list.
 *
 * The composer moved to /invoices/new: it needs a customer, a tier and a line
 * before it can do anything, which is too many decisions to park beside a list.
 * Status filtering stays here because that *is* browsing.
 *
 * Note there are no sortable columns. The list endpoint does not accept a sort
 * key, so offering one would send a request it rejects.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);

  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? '';
  const q = url.searchParams.get('q') ?? '';
  const offset = Number(url.searchParams.get('offset') ?? 0) || 0;

  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (status) params.set('status', status);
  if (q) params.set('q', q);

  const invoices = await api<ListEnvelope<InvoiceRow>>(env, request, `/invoices?${params}`);

  return {
    invoices: invoices.data,
    total: invoices.pagination.total,
    offset,
    pageSize: PAGE_SIZE,
    search: url.search,
    canWrite: can(user.role, 'invoices:write'),
  };
}

export default function InvoicesRoute() {
  const { invoices, total, offset, pageSize, search, canWrite } =
    useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const active = params.get('status') ?? '';

  return (
    <>
      <PageHeader
        title="Invoices"
        description={`${total} invoice${total === 1 ? '' : 's'}`}
        actions={
          canWrite ? (
            <Link
              to="/invoices/new"
              className="inline-flex h-8 items-center rounded-md bg-brand-700 px-3 text-sm font-medium text-white hover:bg-brand-600"
            >
              New invoice
            </Link>
          ) : (
            <span className="text-xs text-ink-muted">Read-only</span>
          )
        }
      />

      <nav aria-label="Filter by status" className="mb-2 flex items-center gap-3 text-sm">
        <a
          href="/invoices"
          className={
            active === ''
              ? 'border-b-2 border-brand-700 pb-0.5 font-medium text-ink'
              : 'pb-0.5 text-ink-muted hover:text-ink'
          }
        >
          All
        </a>
        {INVOICE_STATUSES.map((status) => (
          <a
            key={status}
            href={`/invoices?status=${status}`}
            className={
              active === status
                ? 'border-b-2 border-brand-700 pb-0.5 font-medium capitalize text-ink'
                : 'pb-0.5 capitalize text-ink-muted hover:text-ink'
            }
          >
            {status}
          </a>
        ))}
      </nav>

      <div className="rounded-md border border-border">
        <Table>
          <thead>
            <tr>
              <Th>Number</Th>
              <Th>Customer</Th>
              <Th>Issued</Th>
              <Th className="text-right">Total</Th>
              <Th className="text-right">Balance</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {invoices.length === 0 ? (
              <EmptyRow colSpan={6} message="No invoices yet." />
            ) : (
              invoices.map((invoice) => (
                <tr key={invoice.id} className="hover:bg-muted/40">
                  <Td>
                    <Link
                      to={`/invoices/${invoice.id}`}
                      className="tabular font-medium text-brand-700 hover:underline"
                    >
                      {invoice.invoiceNumber}
                    </Link>
                  </Td>
                  <Td>{invoice.customerName}</Td>
                  <Td className="tabular text-ink-muted">{formatDate(invoice.issueDate)}</Td>
                  <Td className="tabular text-right">{formatCents(invoice.totalCents)}</Td>
                  <Td className="tabular text-right">{formatCents(invoice.balanceCents)}</Td>
                  <Td>
                    <Status tone={statusTone(invoice.status)}>{invoice.status}</Status>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
        <Pagination
          basePath="/invoices"
          current={search}
          total={total}
          limit={pageSize}
          offset={offset}
        />
      </div>
    </>
  );
}
