import { useLoaderData } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';

import { Badge, Card, CardHeader, EmptyRow, PageHeader, Stat, Table, Td, Th, statusTone } from '../components/ui';
import { api, getEnv, requireUser } from '../lib/api.server';
import { canAccessCheckwriting } from '../../src/shared/rbac';
import { formatCents, formatDate } from '../lib/utils';

export const meta = () => [{ title: 'Dashboard · AG Pro Solutions' }];

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

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);

  const [recent, customers, products, sent, drafts] = await Promise.all([
    api<ListEnvelope<InvoiceRow>>(env, request, '/invoices?limit=6'),
    api<ListEnvelope<unknown>>(env, request, '/customers?limit=1'),
    api<ListEnvelope<unknown>>(env, request, '/products?limit=1'),
    api<ListEnvelope<InvoiceRow>>(env, request, '/invoices?status=sent&limit=1'),
    api<ListEnvelope<InvoiceRow>>(env, request, '/invoices?status=draft&limit=1'),
  ]);

  const outstanding = sent.data.reduce((total, invoice) => total + invoice.balanceCents, 0);

  return {
    user,
    recent: recent.data,
    totals: {
      customers: customers.pagination.total,
      products: products.pagination.total,
      awaitingPayment: sent.pagination.total,
      drafts: drafts.pagination.total,
      outstandingCents: outstanding,
    },
    showChecks: canAccessCheckwriting(user.role),
  };
}

export default function DashboardRoute() {
  const { user, recent, totals, showChecks } = useLoaderData<typeof loader>();

  return (
    <>
      <PageHeader
        title={`Good to see you, ${user.name.split(' ')[0]}`}
        description="A snapshot of where the season stands."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Customers" value={String(totals.customers)} />
        <Stat label="Catalogue items" value={String(totals.products)} />
        <Stat label="Draft invoices" value={String(totals.drafts)} hint="Not yet submitted" />
        <Stat
          label="Awaiting payment"
          value={String(totals.awaitingPayment)}
          hint={formatCents(totals.outstandingCents) + ' on the most recent page'}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Recent invoices" description="Newest first" />
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
              {recent.length === 0 ? (
                <EmptyRow colSpan={6} message="No invoices yet." />
              ) : (
                recent.map((invoice) => (
                  <tr key={invoice.id}>
                    <Td>
                      <a className="text-brand-700 underline" href={`/invoices/${invoice.id}`}>
                        {invoice.invoiceNumber}
                      </a>
                    </Td>
                    <Td>{invoice.customerName}</Td>
                    <Td>{formatDate(invoice.issueDate)}</Td>
                    <Td className="tabular text-right">{formatCents(invoice.totalCents)}</Td>
                    <Td className="tabular text-right">{formatCents(invoice.balanceCents)}</Td>
                    <Td>
                      <Badge tone={statusTone(invoice.status)}>{invoice.status}</Badge>
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardHeader title="Your access" description="What this account can do" />
          <dl className="space-y-3 p-4 text-sm">
            <div>
              <dt className="text-ink-muted">Role</dt>
              <dd className="font-medium text-ink capitalize">{user.role}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Checkwriting</dt>
              <dd className="mt-1">
                {showChecks ? (
                  <Badge tone="success">Available</Badge>
                ) : (
                  <Badge tone="danger">Admin only</Badge>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">Inventory</dt>
              <dd className="mt-1">
                <Badge tone={user.role === 'sales' ? 'warning' : 'success'}>
                  {user.role === 'sales' ? 'Read-only' : 'Read and write'}
                </Badge>
              </dd>
            </div>
          </dl>
        </Card>
      </div>
    </>
  );
}
