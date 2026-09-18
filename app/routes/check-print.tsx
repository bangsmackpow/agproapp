import type { CSSProperties } from 'react';
import { Link, useLoaderData } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';

import { api, assertPermission, getEnv, requireUser } from '../lib/api.server';
import { formatCents, formatDate } from '../lib/utils';
import {
  amountInWords,
  buildMicrLine,
  checkTemplateCssVars,
  resolveCheckTemplate,
} from '../../src/shared/check-template';

/**
 * Printable cheque, on three-part stock.
 *
 * Every coordinate comes from the stored template as a CSS custom property, so
 * calibrating the layout is a data change and this component never needs editing.
 * The dashed outline that helps during calibration is screen-only.
 */

export const meta = () => [{ title: 'Check' }];

interface Check {
  id: string;
  checkNumber: number;
  payeeName: string;
  amountCents: number;
  memo: string | null;
  paymentDate: number;
  status: string;
  paymentDescriptor: string | null;
}

interface Allocation {
  id: string;
  amountCents: number;
  note: string | null;
}

interface BankAccount {
  id: string;
  name: string;
  bankName: string | null;
  routingNumber: string | null;
  accountNumber: string | null;
  accountNumberLast4: string | null;
}

interface Company {
  displayName: string;
  legalName: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  phone: string | null;
  checkTemplateConfig: Record<string, unknown> | null;
}

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);
  assertPermission(user, 'checks:read');

  const [payload, company] = await Promise.all([
    api<{ data: { check: Check; allocations: Allocation[]; bankAccount: BankAccount | null } }>(
      env,
      request,
      `/checks/${params.id}`,
    ),
    api<{ data: Company }>(env, request, '/company'),
  ]);

  const template = resolveCheckTemplate(company.data.checkTemplateConfig);

  return {
    check: payload.data.check,
    allocations: payload.data.allocations,
    bankAccount: payload.data.bankAccount,
    company: company.data,
    template,
    cssVars: checkTemplateCssVars(template),
    micrLine: buildMicrLine({
      routingNumber: payload.data.bankAccount?.routingNumber,
      accountNumber: payload.data.bankAccount?.accountNumber,
      checkNumber: payload.data.check.checkNumber,
    }),
  };
}

export default function CheckPrintRoute() {
  const { check, allocations, bankAccount, company, template, cssVars, micrLine } =
    useLoaderData<typeof loader>();

  return (
    <>
      <div className="no-print flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
        <div className="flex items-center gap-3">
          <Link className="text-sm text-accent-text underline" to="/checks">
            Back to checkwriting
          </Link>
          <span className="text-sm text-ink-muted">
            Check #{check.checkNumber} · {formatCents(check.amountCents)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-ink-muted">
            Print at 100% scale with margins set to None.
          </span>
          <button
            type="button"
            onClick={() => window.print()}
            className="h-9 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg"
          >
            Print
          </button>
        </div>
      </div>

      <div className="no-print mx-auto max-w-[8.5in] px-4 pt-4 text-xs text-ink-muted">
        <p>
          The dashed box marks the cheque area. If fields sit outside it, adjust the offsets on the
          Checkwriting screen and reprint — the values are in inches, measured from the top-left of
          the sheet.
        </p>
        {template.micr.show && !micrLine ? (
          <p className="mt-1 text-danger">
            MICR is enabled but the account has no routing and full account number, so no MICR line
            will print.
          </p>
        ) : null}
        {!template.micr.show ? (
          <p className="mt-1">MICR line is off — enable it only for E-13B encoded stock.</p>
        ) : null}
        {bankAccount ? (
          <p className="mt-1">
            Drawn on <span className="font-medium">{bankAccount.name}</span>
            {bankAccount.bankName ? ` · ${bankAccount.bankName}` : ''}
            {bankAccount.accountNumberLast4 ? ` · ••••${bankAccount.accountNumberLast4}` : ''}
          </p>
        ) : (
          <p className="mt-1 text-danger">This check has no bank account attached.</p>
        )}
      </div>

      <div className="bg-muted py-6 print:bg-white print:py-0">
        <div className="print-page print-page--positioned" style={cssVars as CSSProperties}>
          {/* Calibration guide only. */}
          <div
            className="no-print absolute border border-dashed border-danger"
            style={{
              left: 'var(--check-left)',
              top: 'var(--check-top)',
              width: 'var(--check-w)',
              height: 'var(--check-h)',
            }}
          />

          <div
            className="absolute font-[family-name:var(--check-font)] text-[length:var(--check-size)] text-black"
            style={{
              left: 'var(--check-left)',
              top: 'var(--check-top)',
              width: 'var(--check-w)',
              height: 'var(--check-h)',
            }}
          >
            {/* Issuer block */}
            <div
              className="absolute"
              style={{ left: 'var(--payee-left)', top: 'var(--date-top)', maxWidth: 'var(--words-w)' }}
            >
              <p className="text-[0.85em] leading-tight font-semibold">{company.displayName}</p>
              <p className="text-[0.7em] leading-tight">
                {company.addressLine1}
                {company.city ? `, ${company.city}` : ''} {company.state ?? ''}{' '}
                {company.postalCode ?? ''}
              </p>
            </div>

            {/* Cheque number, top right of the instrument */}
            <div
              className="absolute text-right text-[0.85em] tabular"
              style={{ right: '0.35in', top: 'var(--date-top)' }}
            >
              {check.checkNumber}
            </div>

            {/* Date */}
            <div
              className="absolute tabular"
              style={{
                left: 'var(--date-left)',
                top: 'var(--date-top)',
                width: 'var(--date-w)',
                textAlign: 'var(--date-align, left)' as CSSProperties['textAlign'],
              }}
            >
              {formatDate(check.paymentDate)}
            </div>

            {/* Payee */}
            <div
              className="absolute border-b border-black/40"
              style={{
                left: 'var(--payee-left)',
                top: 'var(--payee-top)',
                width: 'var(--payee-w)',
              }}
            >
              {check.payeeName}
            </div>

            {/* Amount, numeric */}
            <div
              className="absolute tabular"
              style={{
                left: 'var(--amount-left)',
                top: 'var(--amount-top)',
                width: 'var(--amount-w)',
                textAlign: 'var(--amount-align, right)' as CSSProperties['textAlign'],
              }}
            >
              {formatCents(check.amountCents)}
            </div>

            {/* Amount, written */}
            <div
              className="absolute overflow-hidden whitespace-nowrap"
              style={{
                left: 'var(--words-left)',
                top: 'var(--words-top)',
                width: 'var(--words-w)',
              }}
            >
              {amountInWords(check.amountCents)}
            </div>

            {/* Memo */}
            <div
              className="absolute overflow-hidden whitespace-nowrap text-[0.85em]"
              style={{
                left: 'var(--memo-left)',
                top: 'var(--memo-top)',
                width: 'var(--memo-w)',
              }}
            >
              {check.memo ?? check.paymentDescriptor ?? ''}
            </div>

            {template.micr.show && micrLine ? (
              <div
                className="absolute whitespace-nowrap"
                style={{
                  left: 'var(--micr-left)',
                  top: 'var(--micr-top)',
                  width: 'var(--micr-w)',
                  letterSpacing: '0.08em',
                }}
              >
                {micrLine}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {allocations.length > 0 ? (
        <div className="no-print mx-auto max-w-[8.5in] px-4 pb-8">
          <h2 className="mb-2 text-sm font-semibold text-ink">Allocations</h2>
          <table className="w-full text-xs">
            <tbody>
              {allocations.map((allocation) => (
                <tr key={allocation.id} className="border-b border-border">
                  <td className="py-1 text-ink-muted">{allocation.note ?? 'Vendor bill'}</td>
                  <td className="tabular py-1 text-right">{formatCents(allocation.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
