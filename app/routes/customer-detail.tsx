import { Link, useActionData, useLoaderData } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

import { Alert, PageHeader, Status } from '../components/ui';
import { CustomerForm, type CustomerDefaults } from '../components/customer-form';
import { actionFailure, api, getEnv, requireUser } from '../lib/api.server';
import { can } from '../../src/shared/rbac';
import { parseCustomerForm } from '../lib/customer-payload.server';

/**
 * The customer record.
 *
 * This is the editing surface: every field the CRM holds, including the ones the
 * list deliberately does not show. Active/inactive is set here rather than by a
 * row action, so changing a customer's standing is an edit like any other and is
 * captured by the audit trail through the same PATCH.
 */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);

  const customer = await api<{ data: CustomerDefaults }>(env, request, `/customers/${params.id}`);

  return {
    customer: customer.data,
    canWrite: can(user.role, 'crm:write'),
  };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const form = await request.formData();
  const id = String(form.get('customerId') ?? '');

  try {
    await api(env, request, `/customers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(parseCustomerForm(form)),
    });
    return { ok: 'Saved.' };
  } catch (error) {
    return actionFailure(error, 'Could not save the customer.');
  }
}

export default function CustomerDetailRoute() {
  const { customer, canWrite } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();

  const location = [customer.billCity, customer.billState].filter(Boolean).join(', ');

  return (
    <>
      <PageHeader
        title={customer.name ?? 'Customer'}
        description={[customer.accountNumber, location].filter(Boolean).join(' · ')}
        actions={
          <Link className="text-sm text-accent-text underline" to="/customers">
            Back to customers
          </Link>
        }
      />

      <div className="mb-3 flex items-center gap-3">
        <Status tone={customer.isActive === false ? 'danger' : 'success'}>
          {customer.isActive === false ? 'Inactive' : 'Active'}
        </Status>
        {customer.taxExempt ? <span className="text-xs text-ink-muted">Tax exempt</span> : null}
      </div>

      {result && 'error' in result ? (
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
      {result && 'ok' in result ? (
        <div className="mb-3">
          <Alert tone="info" title={result.ok} />
        </div>
      ) : null}

      <div className="max-w-4xl rounded-md border border-border">
        <CustomerForm customer={customer} submitLabel="Save changes" />
        {canWrite ? null : (
          <p className="border-t border-border px-3 py-2 text-xs text-ink-muted">
            This account cannot change customers, so saving will be refused.
          </p>
        )}
      </div>
    </>
  );
}
