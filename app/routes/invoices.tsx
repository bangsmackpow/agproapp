import { Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyRow,
  Field,
  Input,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
  statusTone,
} from '../components/ui';
import { api, getEnv, requireUser } from '../lib/api.server';
import { can } from '../../src/shared/rbac';
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

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);

  const [invoices, customers, tiers, programs, products] = await Promise.all([
    api<ListEnvelope<InvoiceRow>>(env, request, '/invoices?limit=100'),
    api<ListEnvelope<CustomerRow>>(env, request, '/customers?limit=200'),
    api<{ data: TierRow[] }>(env, request, '/pricing/tiers'),
    api<{ data: ProgramRow[] }>(env, request, '/programs'),
    api<ListEnvelope<ProductRow>>(env, request, '/products?limit=200'),
  ]);

  return {
    invoices: invoices.data,
    total: invoices.pagination.total,
    customers: customers.data,
    tiers: tiers.data,
    programs: programs.data,
    products: products.data,
    canWrite: can(user.role, 'invoices:write'),
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

  const item =
    lineKind === 'program'
      ? {
          lineType: 'program' as const,
          programId: String(form.get('programId') ?? ''),
          description: String(form.get('programName') ?? 'Application program'),
          acres: Number(form.get('acres') ?? 0),
        }
      : {
          lineType: 'product' as const,
          productId: String(form.get('productId') ?? ''),
          description: String(form.get('productName') ?? 'Product'),
          quantity: Number(form.get('quantity') ?? 1),
        };

  if (item.lineType === 'program' && (!item.programId || !item.acres)) {
    return { error: 'Choose a program and enter the acreage.' };
  }
  if (item.lineType === 'product' && !item.productId) {
    return { error: 'Choose a product.' };
  }

  try {
    await api(env, request, '/invoices', {
      method: 'POST',
      body: JSON.stringify({ customerId, pricingTierKey, items: [item] }),
    });
    return { created: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not create the invoice.' };
  }
}

export default function InvoicesRoute() {
  const { invoices, total, customers, tiers, programs, products, canWrite } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();

  // A program with no price row for the selected tier cannot be sold; flag it.
  const unpricedPrograms = programs.filter((program) => {
    const tier = tiers[0];
    return tier ? program.pricesByTier[tier.key] === undefined : true;
  });

  return (
    <>
      <PageHeader
        title="Invoices"
        description={`${total} invoice${total === 1 ? '' : 's'}`}
        actions={canWrite ? undefined : <Badge tone="warning">Read-only</Badge>}
      />

      {result?.error ? (
        <div className="mb-4">
          <Alert title={result.error} />
        </div>
      ) : null}
      {result?.created ? (
        <div className="mb-4">
          <Alert tone="info" title="Draft invoice created.">
            Open it below to review the compliance gate, then submit.
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-6 2xl:grid-cols-3">
        <Card className="2xl:col-span-2">
          <CardHeader title="All invoices" description="Drafts, sent, paid and canceled" />
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
                  <tr key={invoice.id}>
                    <Td>
                      <Link className="text-brand-700 underline" to={`/invoices/${invoice.id}`}>
                        {invoice.invoiceNumber}
                      </Link>
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

        {canWrite ? (
          <Card>
            <CardHeader title="New invoice" description="Starts as a draft" />
            <Form method="post" className="space-y-3 p-4">
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

              <Field
                label="Pricing tier"
                hint="Drives the markup applied to the cost basis"
              >
                <Select name="pricingTierKey" required defaultValue={tiers[0]?.key ?? ''}>
                  {tiers.map((tier) => (
                    <option key={tier.id} value={tier.key}>
                      {tier.label} ({tier.multiplier}×)
                      {tier.requiresPesticideLicense ? ' — licence required' : ''}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Line type">
                <Select name="lineKind" defaultValue="program">
                  <option value="program">Application program (per acre)</option>
                  <option value="product">Product</option>
                </Select>
              </Field>

              <div className="rounded-md border border-border p-3">
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
                <input type="hidden" name="programName" value="" />
                <div className="mt-3">
                  <Field label="Acres">
                    <Input name="acres" type="number" step="0.1" min="0" placeholder="160" />
                  </Field>
                </div>
              </div>

              <div className="rounded-md border border-border p-3">
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
                <input type="hidden" name="productName" value="" />
                <div className="mt-3">
                  <Field label="Quantity" hint="Carry/misc items need a price; the server fills it from the tier when one is configured">
                    <Input name="quantity" type="number" step="1" min="0" defaultValue={1} />
                  </Field>
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={navigation.state === 'submitting'}>
                {navigation.state === 'submitting' ? 'Creating…' : 'Create draft'}
              </Button>
            </Form>

            {unpricedPrograms.length > 0 ? (
              <div className="border-t border-border p-4">
                <Alert tone="warning" title={`${unpricedPrograms.length} program(s) have no price for at least one tier.`}>
                  Those lines will be refused by the server until the price sheet is loaded.
                </Alert>
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>
    </>
  );
}
