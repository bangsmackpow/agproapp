import { Form, Link, redirect, useActionData, useLoaderData } from 'react-router';
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
  Table,
  Td,
  Th,
} from '../components/ui';
import { actionFailure, api, apiClient, assertCapability, getEnv, requireUser } from '../lib/api.server';
import { can } from '../../src/shared/rbac';

export const meta = () => [{ title: 'Vendors · AG Pro Solutions' }];

/**
 * Who to call when something is low.
 *
 * This is deliberately small. v2 does not pay invoices, so a vendor needs a name,
 * a way to reach them, and the ability to be retired — not an account-payable
 * ledger. The reorder list points here for a reason: an alert without a supplier is
 * a task, and a supplier is an answer.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);
  const client = apiClient(env, request);
  const response = await client.api.vendors.$get({ query: { includeInactive: 'true' } });
  const body = await response.json();

  const products = await client.api.products.$get({ query: { limit: '200' } });
  const productBody = await products.json();

  const suppliedBy = new Map<string, number>();
  for (const product of productBody.data ?? []) {
    if (product.vendorId) {
      suppliedBy.set(product.vendorId, (suppliedBy.get(product.vendorId) ?? 0) + 1);
    }
  }

  return {
    vendors: (body.data ?? []).map((vendor) => ({
      ...vendor,
      productCount: suppliedBy.get(vendor.id) ?? 0,
    })),
    canWrite: can(user.role, 'manageCatalog'),
  };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);
  assertCapability(user, 'manageCatalog');

  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');

  const field = (name: string) => String(form.get(name) ?? '').trim();
  const text = (value: string) => (value === '' ? null : value);

  try {
    if (intent === 'create') {
      const name = field('name');
      if (!name) return { error: 'A vendor needs a name.' };

      await api(env, request, '/vendors', {
        method: 'POST',
        body: JSON.stringify({
          name,
          contactName: text(field('contactName')) ?? undefined,
          phone: text(field('phone')) ?? undefined,
          email: text(field('email')) ?? undefined,
          accountNumber: text(field('accountNumber')) ?? undefined,
        }),
      });
    } else if (intent === 'retire') {
      const id = field('id');
      await api(env, request, `/vendors/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: false }),
      });
    } else {
      return { error: 'Unknown action.' };
    }

    // A plain redirect, not a router redirect: the same action serves a create form
    // and per-row retire buttons, and a full document reload is what clears them.
    return redirect('/vendors');
  } catch (caught) {
    return actionFailure(caught, 'Could not reach the server.');
  }
}

export default function VendorsRoute() {
  const { vendors, canWrite } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();

  return (
    <>
      <PageHeader
        title="Vendors"
        description="Suppliers shown on the reorder list"
        actions={
          canWrite ? (
            <Link className="text-sm text-accent-text underline" to="/inventory">
              Inventory
            </Link>
          ) : null
        }
      />

      {result?.error ? (
        <div className="mb-3">
          <Alert title={result.error} />
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="min-w-0 rounded-md border border-border xl:col-span-2">
          <CardHeader title="Suppliers" />
          <Table>
            <thead>
              <tr>
                <Th>Vendor</Th>
                <Th>Contact</Th>
                <Th>Reach</Th>
                <Th className="text-right">Supplies</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {vendors.length === 0 ? (
                <EmptyRow colSpan={5} message="No vendors yet. Add the one you call most." />
              ) : (
                vendors.map((vendor) => (
                  <tr key={vendor.id} className={vendor.isActive ? '' : 'opacity-60'}>
                    <Td>
                      <span className="font-medium text-ink">{vendor.name}</span>
                      {!vendor.isActive ? <Badge tone="neutral">Retired</Badge> : null}
                      {vendor.accountNumber ? (
                        <div className="tabular text-xs text-ink-muted">
                          their account {vendor.accountNumber}
                        </div>
                      ) : null}
                    </Td>
                    <Td className="text-ink-muted">{vendor.contactName ?? '—'}</Td>
                    <Td className="text-ink-muted">
                      {vendor.phone ?? '—'}
                      {vendor.email ? (
                        <div className="break-all text-xs">{vendor.email}</div>
                      ) : null}
                    </Td>
                    <Td className="tabular text-right">{vendor.productCount}</Td>
                    <Td className="text-right">
                      {canWrite && vendor.isActive ? (
                        <Form method="post" className="inline">
                          <input type="hidden" name="intent" value="retire" />
                          <input type="hidden" name="id" value={vendor.id} />
                          <Button type="submit" variant="ghost" size="sm">
                            Retire
                          </Button>
                        </Form>
                      ) : null}
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </div>

        {canWrite ? (
          <Form method="post" className="rounded-md border border-border self-start">
            <input type="hidden" name="intent" value="create" />
            <CardHeader title="Add a vendor" />
            <div className="grid gap-3 px-3 py-3">
              <Field label="Name">
                <Input name="name" required maxLength={200} />
              </Field>
              <Field label="Contact">
                <Input name="contactName" maxLength={120} />
              </Field>
              <Field label="Phone">
                <Input name="phone" type="tel" maxLength={30} />
              </Field>
              <Field label="Email">
                <Input name="email" type="email" maxLength={200} />
              </Field>
              <Field label="Your account number with them">
                <Input name="accountNumber" maxLength={60} />
              </Field>
              <Button type="submit">Add vendor</Button>
            </div>
          </Form>
        ) : null}
      </div>
    </>
  );
}
