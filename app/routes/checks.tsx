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
import { formatCents, formatDate } from '../lib/utils';
import { resolveCheckTemplate } from '../../src/shared/check-template';

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
  routingNumber: string | null;
  accountNumberLast4: string | null;
  nextCheckNumber: number;
  isActive: boolean;
}

interface CompanyRow {
  checkTemplateConfig: Record<string, unknown> | null;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  // An Admin-only screen: the API enforces this, and the shell hides the link.
  await requireUser(env, request);

  const [checks, accounts, company] = await Promise.all([
    api<{ data: CheckRow[] }>(env, request, '/checks?limit=100'),
    api<{ data: BankAccountRow[] }>(env, request, '/checks/bank-accounts'),
    api<{ data: CompanyRow }>(env, request, '/company'),
  ]);

  return {
    checks: checks.data,
    accounts: accounts.data,
    template: resolveCheckTemplate(company.data.checkTemplateConfig),
  };
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
          routingNumber: String(form.get('routingNumber') ?? '').trim() || undefined,
          accountNumber: String(form.get('accountNumber') ?? '').trim() || undefined,
          nextCheckNumber: Number(form.get('nextCheckNumber') ?? 1001),
        }),
      });
      return { ok: 'Bank account added.' };
    }

    if (intent === 'template') {
      // Numbers arrive as strings; the API normalises and rejects nonsense.
      const number = (name: string): number | undefined => {
        const raw = form.get(name);
        if (raw === null || String(raw).trim() === '') return undefined;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : undefined;
      };

      const config = {
        checkLeftIn: number('checkLeftIn'),
        checkTopIn: number('checkTopIn'),
        checkWidthIn: number('checkWidthIn'),
        checkHeightIn: number('checkHeightIn'),
        fontSizePt: number('fontSizePt'),
        date: { leftIn: number('dateLeftIn'), topIn: number('dateTopIn') },
        payee: {
          leftIn: number('payeeLeftIn'),
          topIn: number('payeeTopIn'),
          widthIn: number('payeeWidthIn'),
        },
        amountNumeric: { leftIn: number('amountLeftIn'), topIn: number('amountTopIn') },
        amountWords: { leftIn: number('wordsLeftIn'), topIn: number('wordsTopIn') },
        memo: { leftIn: number('memoLeftIn'), topIn: number('memoTopIn') },
        micr: {
          leftIn: number('micrLeftIn'),
          topIn: number('micrTopIn'),
          show: form.get('micrShow') === 'on',
        },
      };

      await api(env, request, '/company', {
        method: 'PATCH',
        body: JSON.stringify({ checkTemplateConfig: config }),
      });
      return { ok: 'Check template saved. Reprint a check to check the alignment.' };
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

/** One calibration input. Inches unless `step` says otherwise. */
function OffsetField({
  label,
  name,
  defaultValue,
  step = 0.01,
}: {
  label: string;
  name: string;
  defaultValue: number;
  step?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink">{label}</span>
      <input
        name={name}
        type="number"
        step={step}
        defaultValue={defaultValue}
        className="tabular h-8 w-full rounded-md border border-border bg-white px-2 text-sm"
      />
    </label>
  );
}

export default function ChecksRoute() {
  const { checks, accounts, template } = useLoaderData<typeof loader>();
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
                      <div className="flex flex-wrap gap-2">
                        <Link
                          to={`/checks/${check.id}/print`}
                          className="inline-flex h-8 items-center rounded-md bg-white px-3 text-sm font-medium text-ink ring-1 ring-border"
                        >
                          Open
                        </Link>
                        {check.status === 'draft' ? (
                          <Form method="post">
                            <input type="hidden" name="intent" value="print" />
                            <input type="hidden" name="checkId" value={check.id} />
                            <Button type="submit" size="sm" variant="secondary">
                              Mark printed
                            </Button>
                          </Form>
                        ) : null}
                        {check.status !== 'voided' ? (
                          <Form method="post">
                            <input type="hidden" name="intent" value="void" />
                            <input type="hidden" name="checkId" value={check.id} />
                            <Button
                              type="submit"
                              size="sm"
                              variant="ghost"
                              disabled={navigation.state === 'submitting'}
                            >
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
              <div className="grid grid-cols-2 gap-3">
                <Field label="Routing number" hint="9 digits">
                  <Input name="routingNumber" placeholder="000000000" maxLength={9} />
                </Field>
                <Field label="Account number" hint="Only needed to print MICR">
                  <Input name="accountNumber" placeholder="0000000000" />
                </Field>
              </div>
              <Field label="First check number">
                <Input name="nextCheckNumber" type="number" min="1" defaultValue={1001} />
              </Field>
              <Button type="submit" variant="secondary" className="w-full">
                Add account
              </Button>
            </Form>
          </Card>

          <Card>
            <CardHeader
              title="Check stock calibration"
              description="Inches from the top-left of the sheet. Print a check, measure how far off it is, adjust, reprint."
            />
            <Form method="post" className="space-y-3 p-4">
              <input type="hidden" name="intent" value="template" />

              <div className="grid grid-cols-2 gap-3">
                <OffsetField label="Check left" name="checkLeftIn" defaultValue={template.checkLeftIn} />
                <OffsetField label="Check top" name="checkTopIn" defaultValue={template.checkTopIn} />
                <OffsetField label="Check width" name="checkWidthIn" defaultValue={template.checkWidthIn} />
                <OffsetField
                  label="Check height"
                  name="checkHeightIn"
                  defaultValue={template.checkHeightIn}
                />
              </div>

              <OffsetField
                label="Font size (pt)"
                name="fontSizePt"
                defaultValue={template.fontSizePt}
                step={0.5}
              />

              <fieldset className="rounded-md border border-border p-3">
                <legend className="px-1 text-xs font-medium text-ink-muted">Date</legend>
                <div className="grid grid-cols-2 gap-3">
                  <OffsetField label="Left" name="dateLeftIn" defaultValue={template.date.leftIn} />
                  <OffsetField label="Top" name="dateTopIn" defaultValue={template.date.topIn} />
                </div>
              </fieldset>

              <fieldset className="rounded-md border border-border p-3">
                <legend className="px-1 text-xs font-medium text-ink-muted">Payee</legend>
                <div className="grid grid-cols-3 gap-3">
                  <OffsetField label="Left" name="payeeLeftIn" defaultValue={template.payee.leftIn} />
                  <OffsetField label="Top" name="payeeTopIn" defaultValue={template.payee.topIn} />
                  <OffsetField
                    label="Width"
                    name="payeeWidthIn"
                    defaultValue={template.payee.widthIn ?? 4.7}
                  />
                </div>
              </fieldset>

              <fieldset className="rounded-md border border-border p-3">
                <legend className="px-1 text-xs font-medium text-ink-muted">Amount (numeric)</legend>
                <div className="grid grid-cols-2 gap-3">
                  <OffsetField
                    label="Left"
                    name="amountLeftIn"
                    defaultValue={template.amountNumeric.leftIn}
                  />
                  <OffsetField
                    label="Top"
                    name="amountTopIn"
                    defaultValue={template.amountNumeric.topIn}
                  />
                </div>
              </fieldset>

              <fieldset className="rounded-md border border-border p-3">
                <legend className="px-1 text-xs font-medium text-ink-muted">Amount (written)</legend>
                <div className="grid grid-cols-2 gap-3">
                  <OffsetField
                    label="Left"
                    name="wordsLeftIn"
                    defaultValue={template.amountWords.leftIn}
                  />
                  <OffsetField label="Top" name="wordsTopIn" defaultValue={template.amountWords.topIn} />
                </div>
              </fieldset>

              <fieldset className="rounded-md border border-border p-3">
                <legend className="px-1 text-xs font-medium text-ink-muted">Memo</legend>
                <div className="grid grid-cols-2 gap-3">
                  <OffsetField label="Left" name="memoLeftIn" defaultValue={template.memo.leftIn} />
                  <OffsetField label="Top" name="memoTopIn" defaultValue={template.memo.topIn} />
                </div>
              </fieldset>

              <fieldset className="rounded-md border border-border p-3">
                <legend className="px-1 text-xs font-medium text-ink-muted">MICR line</legend>
                <div className="grid grid-cols-2 gap-3">
                  <OffsetField label="Left" name="micrLeftIn" defaultValue={template.micr.leftIn} />
                  <OffsetField label="Top" name="micrTopIn" defaultValue={template.micr.topIn} />
                </div>
                <label className="mt-2 flex items-center gap-2 text-xs text-ink">
                  <input type="checkbox" name="micrShow" defaultChecked={template.micr.show} />
                  Print MICR (E-13B stock and magnetic toner only)
                </label>
              </fieldset>

              <Button type="submit" variant="secondary" className="w-full">
                Save template
              </Button>
            </Form>
          </Card>
        </div>
      </div>
    </>
  );
}
