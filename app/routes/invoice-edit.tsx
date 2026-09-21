import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

import { Alert, Button, Field, Input, PageHeader, Select } from '../components/ui';
import { InvoiceLinesEditor, type EditorLine, type EditorLineType } from '../components/invoice-lines';
import { actionFailure, api, getEnv, requireUser } from '../lib/api.server';
import { can } from '../../src/shared/rbac';
import { APPLICATION_METHODS } from '../../src/shared/enums';

export const meta = () => [{ title: 'Edit invoice · AG Pro Solutions' }];

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  customerName: string;
  status: string;
  issueDate: number;
  dueDate: number | null;
  termsDays: number | null;
  poNumber: string | null;
  pricingTierKey: string | null;
  serviceAcres: number | null;
  applicationMethod: string | null;
  discountCents: number;
  notes: string | null;
  internalNotes: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  balanceCents: number;
}

interface ItemRow {
  id: string;
  lineType: EditorLineType;
  programId: string | null;
  productId: string | null;
  applicationFeeId: string | null;
  description: string;
  quantity: number;
  unit: string | null;
  acres: number | null;
  unitPriceCents: number;
}

interface TierRow {
  id: string;
  key: string;
  label: string;
  multiplier: number;
}

interface ListEnvelope<T> {
  data: T[];
}

/** Turns a stored line into an editor row. */
function toEditorLine(item: ItemRow): EditorLine {
  return {
    key: item.id,
    lineType: item.lineType,
    programId: item.programId ?? '',
    productId: item.productId ?? '',
    applicationFeeId: item.applicationFeeId ?? '',
    description: item.description,
    quantity: String(item.acres ?? item.quantity),
    acres: item.acres === null ? '' : String(item.acres),
    unitPrice: (item.unitPriceCents / 100).toFixed(2),
    // An application-fee line has no picker in the UI yet, so it is preserved
    // verbatim rather than offered for edit.
    locked: item.lineType === 'application_fee',
  };
}

/**
 * Editing an invoice, on its own screen.
 *
 * Draft and Sent only — `paid` is settled and `canceled` is terminal. The server
 * enforces that too; this only keeps a dead link off the detail page.
 */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);

  if (!can(user.role, 'invoices:write')) {
    throw redirect(`/invoices/${params.id}`);
  }

  const [payload, tiers, programs, products] = await Promise.all([
    api<{ data: InvoiceRow; items: ItemRow[] }>(env, request, `/invoices/${params.id}`),
    api<{ data: TierRow[] }>(env, request, '/pricing/tiers'),
    api<{ data: { id: string; name: string }[] }>(env, request, '/programs'),
    api<ListEnvelope<{ id: string; sku: string; name: string }>>(
      env,
      request,
      '/products?limit=200',
    ),
  ]);

  if (payload.data.status !== 'draft' && payload.data.status !== 'sent') {
    throw redirect(`/invoices/${payload.data.id}`);
  }

  return {
    invoice: payload.data,
    lines: payload.items.map(toEditorLine),
    tiers: tiers.data,
    programs: programs.data,
    products: products.data,
  };
}

export async function action({ request, context, params }: ActionFunctionArgs) {
  const env = getEnv(context);
  const form = await request.formData();

  const payload: Record<string, unknown> = {};

  // An empty string means "clear this field", which the schema expresses as an
  // explicit null. An absent field would mean "leave it alone", which is wrong
  // for a form that always renders every input.
  const setText = (name: string, value: FormDataEntryValue | null) => {
    if (value === null) return;
    const text = String(value).trim();
    payload[name] = text === '' ? null : text;
  };

  const setNumberOrNull = (name: string, value: FormDataEntryValue | null) => {
    if (value === null) return;
    const text = String(value).trim();
    payload[name] = text === '' ? null : Number(text);
  };

  const tier = form.get('pricingTierKey');
  if (tier !== null) payload.pricingTierKey = String(tier);

  setText('poNumber', form.get('poNumber'));
  setText('notes', form.get('notes'));
  setText('internalNotes', form.get('internalNotes'));
  setNumberOrNull('serviceAcres', form.get('serviceAcres'));

  const method = form.get('applicationMethod');
  if (method !== null) {
    const text = String(method);
    payload.applicationMethod = text === '' ? null : text;
  }

  const terms = form.get('termsDays');
  if (terms !== null && String(terms).trim() !== '') payload.termsDays = Number(terms);

  const dueDate = form.get('dueDate');
  if (dueDate !== null && String(dueDate).trim() !== '') payload.dueDate = String(dueDate);

  const discount = form.get('discount');
  if (discount !== null) payload.discountCents = Math.round(Number(discount || 0) * 100);

  const items = form.get('items');
  if (typeof items === 'string' && items.trim() !== '') {
    try {
      payload.items = JSON.parse(items);
    } catch {
      return { error: 'The line items could not be read. Reload the page and try again.' };
    }
  }

  try {
    await api(env, request, `/invoices/${params.id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    return redirect(`/invoices/${params.id}`);
  } catch (error) {
    return actionFailure(error, 'Could not save the invoice.');
  }
}

export default function InvoiceEditRoute() {
  const { invoice, lines, tiers, programs, products } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();

  return (
    <>
      <PageHeader
        title={`Edit ${invoice.invoiceNumber}`}
        description={`${invoice.customerName} · ${invoice.status}`}
        actions={
          <Link className="text-sm text-accent-text underline" to={`/invoices/${invoice.id}`}>
            Back to invoice
          </Link>
        }
      />

      {result?.error ? (
        <div className="mb-3">
          <Alert title={result.error}>
            {result.fieldErrors && Object.keys(result.fieldErrors).length > 0 ? (
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {Object.entries(result.fieldErrors).map(([field, message]) => (
                  <li key={field}>
                    <span className="font-medium">{field}</span>: {message}
                  </li>
                ))}
              </ul>
            ) : null}
          </Alert>
        </div>
      ) : null}

      <div className="max-w-5xl space-y-3">
        <Form method="post" className="space-y-3">
          <fieldset className="grid gap-3 rounded-md border border-border px-3 py-3 sm:grid-cols-3">
            <legend className="px-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
              Account
            </legend>
            <div className="sm:col-span-3">
              <p className="text-xs text-ink-muted">
                The customer and issue date are fixed once an invoice exists — they set the pricing
                and the legal parties. Cancel and reissue to change either.
              </p>
            </div>
            <Field label="Pricing tier" hint="Changing this re-prices every line">
              <Select name="pricingTierKey" defaultValue={invoice.pricingTierKey ?? ''}>
                {tiers.map((tier) => (
                  <option key={tier.id} value={tier.key}>
                    {tier.label} ({tier.multiplier}×)
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="PO number">
              <Input name="poNumber" defaultValue={invoice.poNumber ?? ''} />
            </Field>
            <Field label="Service acres">
              <Input
                name="serviceAcres"
                type="number"
                step="0.1"
                min="0"
                defaultValue={invoice.serviceAcres ?? ''}
              />
            </Field>
            <Field label="Application method">
              <Select name="applicationMethod" defaultValue={invoice.applicationMethod ?? ''}>
                <option value="">—</option>
                {APPLICATION_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {method.charAt(0).toUpperCase() + method.slice(1)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Terms (days)">
              <Input
                name="termsDays"
                type="number"
                step="1"
                min="0"
                defaultValue={invoice.termsDays ?? ''}
              />
            </Field>
            <Field label="Due date">
              <Input
                name="dueDate"
                type="date"
                defaultValue={
                  invoice.dueDate ? new Date(invoice.dueDate).toISOString().slice(0, 10) : ''
                }
              />
            </Field>
            <Field label="Discount ($)" hint="Apportioned across taxable and non-taxable lines">
              <Input
                name="discount"
                type="number"
                step="0.01"
                min="0"
                defaultValue={(invoice.discountCents / 100).toFixed(2)}
              />
            </Field>
          </fieldset>

          <fieldset className="space-y-2 rounded-md border border-border px-3 py-3">
            <legend className="px-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
              Line items
            </legend>
            <InvoiceLinesEditor
              initialLines={lines}
              programs={programs}
              products={products}
            />
          </fieldset>

          <fieldset className="grid gap-3 rounded-md border border-border px-3 py-3">
            <legend className="px-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
              Notes
            </legend>
            <Field label="Notes (printed on the invoice)">
              <textarea
                name="notes"
                rows={3}
                defaultValue={invoice.notes ?? ''}
                className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-ink focus:border-accent focus:ring-2 focus:ring-accent/25 focus:outline-none"
              />
            </Field>
            <Field label="Internal notes" hint="Never printed or emailed">
              <textarea
                name="internalNotes"
                rows={2}
                defaultValue={invoice.internalNotes ?? ''}
                className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-ink focus:border-accent focus:ring-2 focus:ring-accent/25 focus:outline-none"
              />
            </Field>
          </fieldset>

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={navigation.state === 'submitting'}>
              {navigation.state === 'submitting' ? 'Saving…' : 'Save changes'}
            </Button>
            <Link
              className="text-sm text-ink-muted underline"
              to={`/invoices/${invoice.id}`}
            >
              Cancel
            </Link>
          </div>
        </Form>
      </div>
    </>
  );
}
