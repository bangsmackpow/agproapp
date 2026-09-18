import { Link, redirect, useActionData, useLoaderData } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

import { Alert, PageHeader } from '../components/ui';
import { CustomerForm } from '../components/customer-form';
import { actionFailure, api, getEnv, requireUser } from '../lib/api.server';
import { can } from '../../src/shared/rbac';
import { parseCustomerForm } from '../lib/customer-payload.server';

export const meta = () => [{ title: 'New customer · AG Pro Solutions' }];

/**
 * Creating a customer lives on its own screen, not under the account list.
 *
 * The CRM holds more optional fields than the list can justify showing, so they
 * all live here: the list stays scannable and the full record is available once
 * someone has committed to entering one.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);
  return { canWrite: can(user.role, 'crm:write') };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const form = await request.formData();

  try {
    const payload = parseCustomerForm(form);
    const created = await api<{ data?: { id?: string } }>(env, request, '/customers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const id = created?.data?.id;
    return redirect(id ? `/customers/${id}` : '/customers');
  } catch (error) {
    return actionFailure(error, 'Could not create the customer.');
  }
}

export default function CustomerNewRoute() {
  const { canWrite } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();

  return (
    <>
      <PageHeader
        title="New customer"
        description="Billing, licensing and terms"
        actions={
          <Link className="text-sm text-accent-text underline" to="/customers">
            Back to customers
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
          <CustomerForm submitLabel="Create customer" />
        </div>
      ) : (
        <Alert tone="warning" title="This account cannot add customers.">
          Ask an administrator for CRM write access.
        </Alert>
      )}
    </>
  );
}
