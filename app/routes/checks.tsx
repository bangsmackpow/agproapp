import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
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
import { formatCents, formatDate } from '../lib/utils';

export const meta = () => [{ title: 'Checkwriting · AG Pro Solutions' }];

interface CheckRow {
  id: string;
  checkNumber: number;
  payeeName: string;
  amountCents: number;
  memo: string | null;
  paymentDate: number;
  status: string;
}

interface BankAccountRow {
  id: string;
  name: string;
  bankName: string | null;
  nextCheckNumber: number;
  isActive: boolean;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  // An Admin-only screen: the API enforces this, and the shell hides the link.
  await requireUser(env, request);

  const [checks, accounts] = await Promise.all([
    api<{ data: CheckRow[] }>(env, request, '/checks?limit=100'),
    api<{ data: BankAccountRow[] }>(env, request, '/checks/bank-accounts'),
  ]);

  return { checks: checks.data, accounts: accounts.data };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');

  try {
    if (intent === 'account') {
      await api(env, request, '/checks/bank-accounts', {
        method: 'POST',
        body: JSON.stringify({
          name: String(form.get('name') ?? '').trim(),
          bankName: String(form.get('bankName') ?? '').trim() || undefined,
          nextCheckNumber: Number(form.get('nextCheckNumber') ?? 1001),
        }),
      });
      return { ok: 'Bank account added.' };
    }

    if (intent === 'check') {
      const amountCents = Math.round(Number(form.get('amount') ?? 0) * 100);
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        return { error: 'Enter an amount greater than zero.' };
      }

      await api(env, request, '/checks', {
        method: 'POST',
        body: JSON.stringify({
          bankAccountId: String(form.get('bankAccountId') ?? ''),
          payeeName: String(form.get('payeeName') ?? '').trim(),
          amountCents,
          memo: String(form.get('memo') ?? '').trim() || undefined,
        }),
      });
      return { ok: 'Check issued as a draft.' };
    }

    if (intent === 'print' || intent === 'void') {
      const id = String(form.get('checkId') ?? '');
      await api(env, request, `/checks/${id}/${intent}`, {
        method: 'POST',
        ...(intent === 'void' ? { body: JSON.stringify({ reason: 'Voided from the app' }) } : {}),
      });
      return { ok: intent === 'print' ? 'Marked as printed.' : 'Check voided and allocations reversed.' };
    }

    return { error: 'Unknown action.' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That action failed.' };
  }
}

export default function ChecksRoute() {
  const { checks, accounts } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();

  return (
    <>
      <PageHeader
        title="Checkwriting"
        description="Restricted to Administrators. Check numbers are allocated serially and cannot be duplicated."
        actions={<Badge tone="info">Admin only</Badge>}
      />

      {result?.error ? (
        <div className="mb-4">
          <Alert title={result.error} />
        </div>
      ) : null}
      {result?.ok ? (
        <div className="mb-4">
          <Alert tone="info" title={result.ok} />
        </div>
      ) : null}

      {accounts.length === 0 ? (
        <div className="mb-4">
          <Alert tone="warning" title="No bank account configured.">
            Add one before issuing checks — the account holds the check-number counter.
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Issued checks" description="Draft, printed, cleared and voided" />
          <Table>
            <thead>
              <tr>
                <Th>Check</Th>
                <Th>Payee</Th>
                <Th>Date</Th>
                <Th className="text-right">Amount</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {checks.length === 0 ? (
                <EmptyRow colSpan={6} message="No checks issued." />
              ) : (
                checks.map((check) => (
                  <tr key={check.id}>
                    <Td className="tabular font-medium">#{check.checkNumber}</Td>
                    <Td>
                      {check.payeeName}
                      {check.memo ? (
                        <span className="ml-2 text-xs text-ink-muted">{check.memo}</span>
                      ) : null}
                    </Td>
                    <Td>{formatDate(check.paymentDate)}</Td>
                    <Td className="tabular text-right">{formatCents(check.amountCents)}</Td>
                    <Td>
                      <Badge tone={statusTone(check.status)}>{check.status}</Badge>
                    </Td>
                    <Td>
                      <div className="flex gap-2">
                        {check.status === 'draft' ? (
                          <Form method="post">
                            <input type="hidden" name="intent" value="print" />
                            <input type="hidden" name="checkId" value={check.id} />
                            <Button type="submit" size="sm" variant="secondary">
                              Print
                            </Button>
                          </Form>
                        ) : null}
                        {check.status !== 'voided' ? (
                          <Form method="post">
                            <input type="hidden" name="intent" value="void" />
                            <input type="hidden" name="checkId" value={check.id} />
                            <Button type="submit" size="sm" variant="ghost" disabled={navigation.state === 'submitting'}>
                              Void
                            </Button>
                          </Form>
                        ) : null}
                      </div>
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Issue a check"
              description={
                accounts[0]
                  ? `Next number on ${accounts[0].name}: ${accounts[0].nextCheckNumber}`
                  : 'Add a bank account first'
              }
            />
            <Form method="post" className="space-y-3 p-4">
              <input type="hidden" name="intent" value="check" />
              <Field label="Bank account">
                <Select name="bankAccountId" required defaultValue={accounts[0]?.id ?? ''}>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Payee">
                <Input name="payeeName" required placeholder="Wickman Chemical LLC" />
              </Field>
              <Field label="Amount (USD)">
                <Input name="amount" type="number" step="0.01" min="0" required placeholder="0.00" />
              </Field>
              <Field label="Memo">
                <Input name="memo" placeholder="Invoice 103935" />
              </Field>
              <Button type="submit" className="w-full" disabled={accounts.length === 0}>
                Issue draft check
              </Button>
            </Form>
          </Card>

          <Card>
            <CardHeader title="Add a bank account" />
            <Form method="post" className="space-y-3 p-4">
              <input type="hidden" name="intent" value="account" />
              <Field label="Account name">
                <Input name="name" required placeholder="Operating" />
              </Field>
              <Field label="Bank">
                <Input name="bankName" placeholder="Optional" />
              </Field>
              <Field label="First check number">
                <Input name="nextCheckNumber" type="number" min="1" defaultValue={1001} />
              </Field>
              <Button type="submit" variant="secondary" className="w-full">
                Add account
              </Button>
            </Form>
          </Card>
        </div>
      </div>
    </>
  );
}
