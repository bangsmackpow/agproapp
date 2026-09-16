import { Form, useActionData, useLoaderData, useNavigation, useSearchParams } from 'react-router';
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
  Table,
  Td,
  Th,
} from '../components/ui';
import { api, getEnv, requireUser } from '../lib/api.server';
import { can } from '../../src/shared/rbac';

export const meta = () => [{ title: 'Customers · AG Pro Solutions' }];

interface CustomerRow {
  id: string;
  accountNumber: string;
  name: string;
  phone: string | null;
  billCity: string | null;
  billState: string | null;
  pesticideLicenseNumber: string | null;
  isActive: boolean;
}

interface ListEnvelope<T> {
  data: T[];
  pagination: { total: number };
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);

  const q = new URL(request.url).searchParams.get('q') ?? '';
  const query = q ? `&q=${encodeURIComponent(q)}` : '';

  const customers = await api<ListEnvelope<CustomerRow>>(env, request, `/customers?limit=100${query}`);

  return {
    customers: customers.data,
    total: customers.pagination.total,
    q,
    canWrite: can(user.role, 'crm:write'),
  };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const form = await request.formData();

  const payload = {
    accountNumber: String(form.get('accountNumber') ?? '').trim(),
    name: String(form.get('name') ?? '').trim(),
    contactName: String(form.get('contactName') ?? '').trim() || undefined,
    phone: String(form.get('phone') ?? '').trim() || undefined,
    email: String(form.get('email') ?? '').trim() || undefined,
    billCity: String(form.get('billCity') ?? '').trim() || undefined,
    billState: String(form.get('billState') ?? '').trim() || undefined,
    pesticideLicenseNumber: String(form.get('pesticideLicenseNumber') ?? '').trim() || undefined,
  };

  try {
    await api(env, request, '/customers', { method: 'POST', body: JSON.stringify(payload) });
    return { created: payload.name };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not create the customer.' };
  }
}

export default function CustomersRoute() {
  const { customers, total, q, canWrite } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [params] = useSearchParams();
  const navigation = useNavigation();

  return (
    <>
      <PageHeader
        title="Customers"
        description={`${total} account${total === 1 ? '' : 's'} on file`}
        actions={
          <Form method="get" className="flex items-end gap-2">
            <Input
              name="q"
              defaultValue={params.get('q') ?? ''}
              placeholder="Search name, account or phone"
              aria-label="Search customers"
            />
            <Button type="submit" variant="secondary">
              Search
            </Button>
          </Form>
        }
      />

      {result?.created ? (
        <div className="mb-4">
          <Alert tone="info" title={`Created ${result.created}.`} />
        </div>
      ) : null}
      {result?.error ? (
        <div className="mb-4">
          <Alert title={result.error} />
        </div>
      ) : null}
      {q ? (
        <p className="mb-4 text-sm text-ink-muted">
          Showing results for “{q}”. <a className="underline" href="/customers">Clear</a>
        </p>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Accounts" description="Purchase history lives on each account" />
          <Table>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th>Name</Th>
                <Th>Location</Th>
                <Th>Phone</Th>
                <Th>Pesticide licence</Th>
              </tr>
            </thead>
            <tbody>
              {customers.length === 0 ? (
                <EmptyRow colSpan={5} message="No customers match." />
              ) : (
                customers.map((customer) => (
                  <tr key={customer.id}>
                    <Td className="font-medium">{customer.accountNumber}</Td>
                    <Td>
                      {customer.name}
                      {customer.isActive ? null : (
                        <span className="ml-2">
                          <Badge tone="danger">Inactive</Badge>
                        </span>
                      )}
                    </Td>
                    <Td>
                      {[customer.billCity, customer.billState].filter(Boolean).join(', ') || '—'}
                    </Td>
                    <Td>{customer.phone ?? '—'}</Td>
                    <Td>
                      {customer.pesticideLicenseNumber ? (
                        <span className="tabular">{customer.pesticideLicenseNumber}</span>
                      ) : (
                        <Badge tone="warning">Not on file</Badge>
                      )}
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </Card>

        {canWrite ? (
          <Card>
            <CardHeader title="Add a customer" />
            <Form method="post" className="space-y-3 p-4">
              <Field label="Account number">
                <Input name="accountNumber" required placeholder="AGP-003" />
              </Field>
              <Field label="Name">
                <Input name="name" required placeholder="Prairie Ridge Farms" />
              </Field>
              <Field label="Contact">
                <Input name="contactName" placeholder="Optional" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Phone">
                  <Input name="phone" placeholder="641-555-0100" />
                </Field>
                <Field label="City">
                  <Input name="billCity" placeholder="Creston" />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="State">
                  <Input name="billState" maxLength={2} placeholder="IA" />
                </Field>
                <Field
                  label="Pesticide licence"
                  hint="Required at time of sale for carry tiers"
                >
                  <Input name="pesticideLicenseNumber" />
                </Field>
              </div>
              <Button type="submit" disabled={navigation.state === 'submitting'}>
                {navigation.state === 'submitting' ? 'Saving…' : 'Create customer'}
              </Button>
            </Form>
          </Card>
        ) : null}
      </div>
    </>
  );
}
