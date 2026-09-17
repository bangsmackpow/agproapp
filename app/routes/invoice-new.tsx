import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

import { Alert, Button, Field, Input, PageHeader, Select } from '../components/ui';
import { actionFailure, api, getEnv, requireUser } from '../lib/api.server';

export const meta = () => [{ title: 'New invoice · AG Pro Solutions' }];

interface CustomerRow {
  id: string;
  name: string;
  accountNumber: string;
}

interface TierRow {
  id: string;
  key: string;
  label: string;
  multiplier: number;
  requiresPesticideLicense: boolean;
}

interface ProgramRow {
  id: string;
  name: string;
  crop: string;
  ingredientCount: number;
  pricesByTier: Record<string, number>;
}

interface ProductRow {
  id: string;
  name: string;
  sku: string;
  unit: string;
}

interface ListEnvelope<T> {
  data: T[];
}

/**
 * Creating an invoice, on its own screen.
 *
 * The composer needs a customer, a pricing tier, a line type and then either a
 * program with acreage or a product with a quantity. That is too many decisions
 * to sit permanently beside a list someone is trying to read, so the list keeps a
 * single link to this page. Starting a draft is an act, not a filter.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  await requireUser(env, request);

  const [customers, tiers, programs, products] = await Promise.all([
    api<ListEnvelope<CustomerRow>>(env, request, '/customers?limit=200'),
    api<{ data: TierRow[] }>(env, request, '/pricing/tiers'),
    api<{ data: ProgramRow[] }>(env, request, '/programs'),
    api<ListEnvelope<ProductRow>>(env, request, '/products?limit=200'),
  ]);

  return {
    customers: customers.data,
    tiers: tiers.data,
    programs: programs.data,
    products: products.data,
  };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const form = await request.formData();

  const customerId = String(form.get('customerId') ?? '');
  const pricingTierKey = String(form.get('pricingTierKey') ?? '');
  const lineKind = String(form.get('lineKind') ?? 'program');

  if (!customerId || !pricingTierKey) {
    return { error: 'Choose a customer and a pricing tier.' };
  }

  // No description is sent: the server derives it from the program or product,
  // which it loads anyway. See the note in src/services/invoicing.ts.
  const item =
    lineKind === 'program'
      ? {
          lineType: 'program' as const,
          programId: String(form.get('programId') ?? ''),
          acres: Number(form.get('acres') ?? 0),
        }
      : {
          lineType: 'product' as const,
          productId: String(form.get('productId') ?? ''),
          quantity: Number(form.get('quantity') ?? 1),
        };

  if (item.lineType === 'program' && (!item.programId || !item.acres)) {
    return { error: 'Choose a program and enter the acreage.' };
  }
  if (item.lineType === 'product' && !item.productId) {
    return { error: 'Choose a product.' };
  }

  try {
    const created = await api<{ data?: { id?: string } }>(env, request, '/invoices', {
      method: 'POST',
      body: JSON.stringify({ customerId, pricingTierKey, items: [item] }),
    });

    const id = created?.data?.id;
    return redirect(id ? `/invoices/${id}` : '/invoices');
  } catch (error) {
    return actionFailure(error, 'Could not create the invoice.');
  }
}

export default function InvoiceNewRoute() {
  const { customers, tiers, programs, products } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();

  // A program with no price row for the selected tier cannot be sold. Surfacing
  // this before the attempt is kinder than a refusal after it.
  const unpriced = programs.filter((program) => {
    const tier = tiers[0];
    return tier ? program.pricesByTier[tier.key] === undefined : true;
  });

  return (
    <>
      <PageHeader
        title="New invoice"
        description="Starts as a draft"
        actions={
          <Link className="text-sm text-brand-700 underline" to="/invoices">
            Back to invoices
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

      <div className="max-w-3xl space-y-3">
        {unpriced.length > 0 ? (
          <Alert
            tone="warning"
            title={`${unpriced.length} program(s) have no price for at least one tier.`}
          >
            Those lines will be refused by the server until the price sheet is loaded.
          </Alert>
        ) : null}

        <Form method="post" className="rounded-md border border-border">
          <fieldset className="grid gap-3 border-b border-border px-3 py-3 sm:grid-cols-2">
            <legend className="px-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
              Account
            </legend>
            <Field label="Customer">
              <Select name="customerId" required defaultValue="">
                <option value="" disabled>
                  Choose a customer…
                </option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.accountNumber} — {customer.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Pricing tier" hint="Drives the markup applied to the cost basis">
              <Select name="pricingTierKey" required defaultValue={tiers[0]?.key ?? ''}>
                {tiers.map((tier) => (
                  <option key={tier.id} value={tier.key}>
                    {tier.label} ({tier.multiplier}×)
                    {tier.requiresPesticideLicense ? ' — licence required' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </fieldset>

          <fieldset className="grid gap-3 border-b border-border px-3 py-3 sm:grid-cols-3">
            <legend className="px-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
              Line
            </legend>
            <Field label="Line type">
              <Select name="lineKind" defaultValue="program">
                <option value="program">Application program (per acre)</option>
                <option value="product">Product</option>
              </Select>
            </Field>
            <Field label="Program">
              <Select name="programId" defaultValue="">
                <option value="">—</option>
                {programs.map((program) => (
                  <option key={program.id} value={program.id}>
                    {program.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Acres">
              <Input name="acres" type="number" step="0.1" min="0" placeholder="160" />
            </Field>
            <Field label="Product">
              <Select name="productId" defaultValue="">
                <option value="">—</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} — {product.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Quantity"
              hint="Carry and misc items need a price; the tier fills it when one is configured"
            >
              <Input name="quantity" type="number" step="1" min="0" defaultValue={1} />
            </Field>
          </fieldset>

          <div className="px-3 py-2">
            <Button type="submit" disabled={navigation.state === 'submitting'}>
              {navigation.state === 'submitting' ? 'Creating…' : 'Create draft'}
            </Button>
          </div>
        </Form>
      </div>
    </>
  );
}
