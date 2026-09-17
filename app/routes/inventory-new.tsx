import { Link, redirect, useActionData, useLoaderData } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

import { Alert, PageHeader } from '../components/ui';
import { ProductForm, type UnitOption } from '../components/product-form';
import { actionFailure, api, getEnv, requireUser } from '../lib/api.server';
import { can } from '../../src/shared/rbac';
import { parseProductForm } from '../lib/product-payload.server';

export const meta = () => [{ title: 'New product · AG Pro Solutions' }];

/**
 * Creating a product lives on its own screen rather than under the catalogue.
 *
 * The catalogue is for scanning — find the item, read its stock, open it. A form
 * with every optional field sitting beneath that list competes with the job the
 * screen is actually for, so the browse view keeps only a link to this page.
 * Complexity belongs where someone has already decided to work on one record.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);

  const units = await api<{ data: UnitOption[] }>(env, request, '/units');

  return {
    units: units.data,
    canWrite: can(user.role, 'inventory:write'),
  };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const form = await request.formData();

  try {
    const cleaned = parseProductForm(form);
    const created = await api<{ data?: { id?: string } }>(env, request, '/products', {
      method: 'POST',
      body: JSON.stringify(cleaned),
    });

    // Land on the record just created. Saving a form and being left staring at
    // the same empty form gives no confirmation that anything happened.
    const id = created?.data?.id;
    return redirect(id ? `/inventory/${id}` : '/inventory');
  } catch (error) {
    return actionFailure(error, 'Could not create the product.');
  }
}

export default function InventoryNewRoute() {
  const { units, canWrite } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();

  return (
    <>
      <PageHeader
        title="New product"
        description="Sections appear according to the division"
        actions={
          <Link className="text-sm text-brand-700 underline" to="/inventory">
            Back to inventory
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

      {canWrite ? (
        <div className="max-w-4xl rounded-md border border-border">
          <ProductForm units={units} submitLabel="Create product" />
        </div>
      ) : (
        <Alert tone="warning" title="This account cannot add products.">
          Ask an administrator for inventory write access.
        </Alert>
      )}
    </>
  );
}
