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
import { ApiError, api, getEnv, requireUser } from '../lib/api.server';
import { can } from '../../src/shared/rbac';
import { formatCents, formatDate } from '../lib/utils';

export const meta = () => [{ title: 'Invoice · AG Pro Solutions' }];

interface Invoice {
  id: string;
  invoiceNumber: string;
  customerName: string;
  status: string;
  issueDate: number;
  dueDate: number | null;
  pricingTierKey: string | null;
  serviceAcres: number | null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  amountPaidCents: number;
  balanceCents: number;
  complianceVerifiedAt: number | null;
  notes: string | null;
}

interface InvoiceItem {
  id: string;
  lineType: string;
  description: string;
  quantity: number;
  unit: string | null;
  acres: number | null;
  unitPriceCents: number;
  unitCostCents: number | null;
  marginPercent: number | null;
  lineSubtotalCents: number;
  lotNumber: string | null;
  complianceLogId: string | null;
}

interface ComplianceViolation {
  invoiceItemId: string;
  description: string;
  reason: string;
}

interface DeliveryRow {
  id: string;
  method: string;
  destination: string | null;
  status: string;
  error: string | null;
  sentAt: number | null;
  createdAt: number;
}

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);

  const [payload, deliveries] = await Promise.all([
    api<{
      data: Invoice;
      items: InvoiceItem[];
      compliance: { satisfied: boolean; violations: ComplianceViolation[] };
    }>(env, request, `/invoices/${params.id}`),
    api<{ data: DeliveryRow[] }>(env, request, `/invoices/${params.id}/deliveries`),
  ]);

  return {
    invoice: payload.data,
    items: payload.items,
    compliance: payload.compliance,
    deliveries: deliveries.data,
    permissions: {
      send: can(user.role, 'invoices:send'),
      cancel: can(user.role, 'invoices:cancel'),
      recordPayment: can(user.role, 'invoices:write'),
    },
  };
}

export async function action({ request, context, params }: ActionFunctionArgs) {
  const env = getEnv(context);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');

  try {
    if (intent === 'send') {
      await api(env, request, `/invoices/${params.id}/send`, { method: 'POST' });
      return { ok: 'Invoice submitted.' };
    }
    if (intent === 'cancel') {
      await api(env, request, `/invoices/${params.id}/cancel`, { method: 'POST' });
      return { ok: 'Invoice canceled.' };
    }
    if (intent === 'payment') {
      const amountCents = Math.round(Number(form.get('amount') ?? 0) * 100);
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        return { error: 'Enter a payment amount greater than zero.' };
      }
      await api(env, request, `/invoices/${params.id}/payments`, {
        method: 'POST',
        body: JSON.stringify({ amountCents }),
      });
      return { ok: 'Payment recorded.' };
    }
    if (intent === 'deliver') {
      const to = String(form.get('to') ?? '').trim();
      try {
        const result = await api<{ data: { delivery: { status: string; error: string | null } } }>(
          env,
          request,
          `/invoices/${params.id}/deliveries`,
          {
            method: 'POST',
            body: JSON.stringify({ method: 'email', ...(to ? { to } : {}) }),
          },
        );

        const { status, error } = result.data.delivery;
        if (status === 'sent') return { ok: 'Invoice emailed.' };
        // 'skipped' means no provider is configured — not a failure, a gap.
        return { warning: error ?? `Delivery ${status}.` };
      } catch (error) {
        // A failed send returns 502 with the delivery record in the body.
        if (error instanceof ApiError && error.status === 502) {
          const payload = error.payload as { data?: { delivery?: { error?: string | null } } } | null;
          return { error: payload?.data?.delivery?.error ?? 'The mail provider refused the message.' };
        }
        throw error;
      }
    }

    if (intent === 'record-print') {
      await api(env, request, `/invoices/${params.id}/deliveries`, {
        method: 'POST',
        body: JSON.stringify({ method: 'print' }),
      });
      return { ok: 'Print recorded.' };
    }

    return { error: 'Unknown action.' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That action failed.' };
  }
}

export default function InvoiceDetailRoute() {
  const { invoice, items, compliance, deliveries, permissions } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();

  const isOpen = invoice.status === 'draft' || invoice.status === 'sent';

  return (
    <>
      <PageHeader
        title={invoice.invoiceNumber}
        description={`${invoice.customerName} · issued ${formatDate(invoice.issueDate)}`}
        actions={
          <div className="flex items-center gap-3">
            <Status tone={statusTone(invoice.status)}>{invoice.status}</Status>
            <Link
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-ink ring-1 ring-border"
              to={`/invoices/${invoice.id}/print`}
            >
              Print view
            </Link>
            <Link className="text-sm text-brand-700 underline" to="/invoices">
              All invoices
            </Link>
          </div>
        }
      />

      {result?.error ? (
        <div className="mb-4">
          <Alert title={result.error} />
        </div>
      ) : null}
      {result?.warning ? (
        <div className="mb-4">
          <Alert tone="warning" title={result.warning} />
        </div>
      ) : null}
      {result?.ok ? (
        <div className="mb-4">
          <Alert tone="info" title={result.ok} />
        </div>
      ) : null}

      {invoice.status === 'draft' ? (
        <div className="mb-4">
          {compliance.satisfied ? (
            <Alert tone="info" title="Compliance satisfied.">
              Every regulated seed line has verified BOL/CMR and Order Number tokens.
            </Alert>
          ) : (
            <Alert title="Submission blocked by Iowa seed compliance.">
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {compliance.violations.map((violation) => (
                  <li key={violation.invoiceItemId}>
                    <span className="font-medium">{violation.description}</span> — {violation.reason}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="rounded-md border border-border">
          <CardHeader title="Line items" description={`Pricing tier: ${invoice.pricingTierKey ?? '—'}`} />
          <Table>
            <thead>
              <tr>
                <Th>Description</Th>
                <Th>Type</Th>
                <Th className="text-right">Qty / acres</Th>
                <Th className="text-right">Unit price</Th>
                <Th className="text-right">Margin</Th>
                <Th className="text-right">Amount</Th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <EmptyRow colSpan={6} message="No line items." />
              ) : (
                items.map((item) => (
                  <tr key={item.id}>
                    <Td>
                      {item.description}
                      {item.lotNumber ? (
                        <span className="ml-2 text-xs text-ink-muted">lot {item.lotNumber}</span>
                      ) : null}
                      {item.complianceLogId ? (
                        <span className="ml-2">
                          <Badge tone="success">Compliance on file</Badge>
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone="neutral">{item.lineType}</Badge>
                    </Td>
                    <Td className="tabular text-right">
                      {item.acres ?? item.quantity} {item.unit ?? ''}
                    </Td>
                    <Td className="tabular text-right">{formatCents(item.unitPriceCents)}</Td>
                    <Td className="tabular text-right">
                      {item.marginPercent === null ? '—' : `${item.marginPercent.toFixed(1)}%`}
                    </Td>
                    <Td className="tabular text-right">{formatCents(item.lineSubtotalCents)}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>

          <dl className="space-y-1 border-t border-border p-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-muted">Subtotal</dt>
              <dd className="tabular">{formatCents(invoice.subtotalCents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-muted">Discount</dt>
              <dd className="tabular">−{formatCents(invoice.discountCents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-muted">Tax</dt>
              <dd className="tabular">{formatCents(invoice.taxCents)}</dd>
            </div>
            <div className="flex justify-between border-t border-border pt-1 font-semibold">
              <dt>Total</dt>
              <dd className="tabular">{formatCents(invoice.totalCents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-muted">Paid</dt>
              <dd className="tabular">{formatCents(invoice.amountPaidCents)}</dd>
            </div>
            <div className="flex justify-between font-semibold">
              <dt>Balance</dt>
              <dd className="tabular">{formatCents(invoice.balanceCents)}</dd>
            </div>
          </dl>
        </div>

        <div className="space-y-6">
          <div className="rounded-md border border-border">
            <CardHeader title="Invoice details" />
            <dl className="space-y-2 p-4 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Service acres</dt>
                <dd className="tabular">{invoice.serviceAcres ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Due</dt>
                <dd>{formatDate(invoice.dueDate)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Compliance verified</dt>
                <dd>{formatDate(invoice.complianceVerifiedAt)}</dd>
              </div>
            </dl>
          </div>

          {isOpen ? (
            <div className="rounded-md border border-border">
              <CardHeader title="Actions" />
              <div className="space-y-2 p-3">
                {invoice.status === 'draft' && permissions.send ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="send" />
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={!compliance.satisfied || navigation.state === 'submitting'}
                    >
                      {compliance.satisfied ? 'Submit invoice' : 'Blocked by compliance'}
                    </Button>
                  </Form>
                ) : null}

                {invoice.status === 'sent' && permissions.recordPayment ? (
                  <Form method="post" className="space-y-2">
                    <input type="hidden" name="intent" value="payment" />
                    <Field label="Record a payment">
                      <Input name="amount" type="number" step="0.01" min="0" placeholder="0.00" />
                    </Field>
                    <Button type="submit" className="w-full">
                      Record payment
                    </Button>
                  </Form>
                ) : null}

                {permissions.send ? (
                  <div className="space-y-3 border-t border-border pt-3">
                    <Form method="post" className="space-y-2">
                      <input type="hidden" name="intent" value="deliver" />
                      <Field
                        label="Email this invoice"
                        hint="Leaves the recipient blank to use the address on the customer record"
                      >
                        <Input name="to" type="email" placeholder="customer@example.com" />
                      </Field>
                      <Button type="submit" variant="secondary" className="w-full">
                        Send by email
                      </Button>
                    </Form>

                    <Form method="post">
                      <input type="hidden" name="intent" value="record-print" />
                      <Button type="submit" variant="ghost" className="w-full">
                        Record a print
                      </Button>
                    </Form>
                  </div>
                ) : null}

                {permissions.cancel ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="cancel" />
                    <Button type="submit" variant="secondary" className="w-full">
                      Cancel invoice
                    </Button>
                  </Form>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="rounded-md border border-border">
            <CardHeader
              title="Delivery history"
              description="What left the office, and whether it actually went"
            />
            <Table>
              <thead>
                <tr>
                  <Th>Method</Th>
                  <Th>Destination</Th>
                  <Th>When</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {deliveries.length === 0 ? (
                  <EmptyRow colSpan={4} message="Nothing delivered yet." />
                ) : (
                  deliveries.map((delivery) => (
                    <tr key={delivery.id}>
                      <Td className="capitalize">{delivery.method}</Td>
                      <Td className="break-all">{delivery.destination ?? '—'}</Td>
                      <Td>{formatDate(delivery.sentAt ?? delivery.createdAt)}</Td>
                      <Td>
                        <Status tone={statusTone(delivery.status)}>{delivery.status}</Status>
                        {delivery.error ? (
                          <span className="mt-1 block text-xs text-danger">{delivery.error}</span>
                        ) : null}
                      </Td>
                    </tr>
                  ))
                )}
              </tbody>
            </Table>
          </div>
        </div>
      </div>
    </>
  );
}
