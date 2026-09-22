import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

import { Alert, Button, CardHeader, PageHeader } from '../components/ui';
import { ProductForm } from '../components/product-form';
import { parseProductForm } from '../lib/product-payload.server';
import { actionFailure, api, apiClient, assertCapability, getEnv, requireUser } from '../lib/api.server';

export const meta = () => [{ title: 'New product · AG Pro Solutions' }];

/**
 * Cataloguing a product, on its own screen.
 *
 * A product is where the pricing rule meets reality: its unit and its cost decide
 * every invoice line that references it, and its regulated-seed flag decides
 * whether an invoice can be issued at all. That is not a few fields to squeeze
 * under a list someone is trying to scan.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);
  assertCapability(user, 'manageCatalog');

  const client = apiClient(env, request);
  const vendors = await client.api.vendors.$get();

  return {
    vendors: ((await vendors.json()).data ?? []).map((vendor) => ({
      id: vendor.id,
      name: vendor.name,
    })),
  };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);
  assertCapability(user, 'manageCatalog');

  const { payload, error } = parseProductForm(await request.formData(), 'create');
  if (error) return { error };

  try {
    // Writes go through `api()` rather than the typed client: see the note in
    // app/lib/api.server.ts. The response is only read for the new id.
    const created = await api<{ data?: { id?: string } }>(env, request, '/products', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const id = created?.data?.id;
    return redirect(id ? `/inventory/${id}` : '/inventory');
  } catch (caught) {
    return actionFailure(caught, 'Could not create the product.');
  }
}

export default function InventoryNewRoute() {
  const { vendors } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();

  return (
    <>
      <PageHeader
        title="New product"
        description="Chemical, seed, drone or misc — one unit, one cost"
        actions={
          <Link className="text-sm text-accent-text underline" to="/inventory">
            Back to inventory
          </Link>
        }
      />

      {result?.error ? (
        <div className="mb-3">
          <Alert title={result.error} />
        </div>
      ) : null}

      <Form method="post" className="max-w-4xl">
        <div className="rounded-md border border-border">
          <CardHeader title="Product" description="Cost drives the sell price; the unit drives the reorder alert" />
          <div className="px-3 py-3">
            <ProductForm vendors={vendors} />
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Button type="submit" disabled={navigation.state === 'submitting'}>
            {navigation.state === 'submitting' ? 'Saving…' : 'Create product'}
          </Button>
          <Link to="/inventory" className="text-sm text-ink-muted underline">
            Cancel
          </Link>
        </div>
      </Form>

      <p className="mt-3 max-w-4xl text-xs text-ink-muted">
        No stock arrives with the product. Use <strong>Receive stock</strong> on its page once the
        delivery is in hand, so the ledger records when it arrived and at what cost.
      </p>
    </>
  );
}
