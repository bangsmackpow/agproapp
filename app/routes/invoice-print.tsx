import { Link, useLoaderData } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';

import { api, getEnv, requireUser } from '../lib/api.server';
import { formatCents, formatDate } from '../lib/utils';

/**
 * Printable invoice, in standard letter format.
 *
 * Deliberately outside the shell layout: no navigation, no chrome, nothing that
 * would land on paper. All screen-only affordances carry `no-print`.
 */

export const meta = () => [{ title: 'Invoice' }];

interface Company {
  legalName: string;
  displayName: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  pesticideLicenseNumber: string | null;
}

interface Invoice {
  id: string;
  invoiceNumber: string;
  customerName: string;
  status: string;
  issueDate: number;
  dueDate: number | null;
  termsDays: number | null;
  poNumber: string | null;
  pricingTierKey: string | null;
  serviceAcres: number | null;
  billLine1: string | null;
  billLine2: string | null;
  billCity: string | null;
  billState: string | null;
  billPostalCode: string | null;
  shipLine1: string | null;
  shipLine2: string | null;
  shipCity: string | null;
  shipState: string | null;
  shipPostalCode: string | null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  amountPaidCents: number;
  balanceCents: number;
  notes: string | null;
}

interface Item {
  id: string;
  lineType: string;
  description: string;
  quantity: number;
  unit: string | null;
  acres: number | null;
  unitPriceCents: number;
  lineSubtotalCents: number;
}

interface ComplianceToken {
  invoiceItemId: string;
  description: string;
  bolCmrNumber: string | null;
  orderNumber: string | null;
  seedNumber: string | null;
  lotNumber: string | null;
  verified: boolean;
}

function addressLines(parts: (string | null)[]): string {
  const present = parts.filter((part): part is string => Boolean(part && part.trim()));
  return present.join(', ');
}

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = getEnv(context);
  await requireUser(env, request);

  const [company, invoice] = await Promise.all([
    api<{ data: Company }>(env, request, '/company'),
    api<{
      data: Invoice;
      items: Item[];
      complianceTokens: ComplianceToken[];
      compliance: { satisfied: boolean };
    }>(env, request, `/invoices/${params.id}`),
  ]);

  return { company: company.data, ...invoice };
}

export default function InvoicePrintRoute() {
  const { company, data: invoice, items, complianceTokens, compliance } = useLoaderData<typeof loader>();

  const letterhead = [
    company.addressLine1,
    company.addressLine2,
    addressLines([company.city, company.state]) + (company.postalCode ? ` ${company.postalCode}` : ''),
  ].filter((line): line is string => Boolean(line && line.trim()));

  return (
    <>
      <div className="no-print flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
        <div className="flex items-center gap-3">
          <Link className="text-sm text-accent-text underline" to={`/invoices/${invoice.id}`}>
            Back to invoice
          </Link>
          <span className="text-sm text-ink-muted">
            {invoice.invoiceNumber} · {invoice.customerName}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-ink-muted">
            Print at 100% scale. Disable browser headers and footers.
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

      <div className="bg-muted py-6 print:bg-white print:py-0">
        <div className="print-page print-page--letter">
          <header className="flex items-start justify-between gap-8 border-b-2 border-brand-700 pb-4">
            <div>
              <h1 className="text-xl font-bold text-brand-900">{company.displayName}</h1>
              <p className="text-xs text-gray-600">{company.legalName}</p>
              <div className="mt-2 text-xs leading-5 text-gray-700">
                {letterhead.map((line) => (
                  <p key={line}>{line}</p>
                ))}
                {company.phone ? <p>{company.phone}</p> : null}
                {company.email ? <p>{company.email}</p> : null}
              </div>
            </div>

            <div className="text-right">
              <p className="text-2xl font-bold tracking-wide text-gray-900">INVOICE</p>
              <table className="mt-3 ml-auto text-xs">
                <tbody className="text-gray-700">
                  <tr>
                    <td className="pr-3 text-right font-medium">Invoice</td>
                    <td className="tabular text-right">{invoice.invoiceNumber}</td>
                  </tr>
                  <tr>
                    <td className="pr-3 text-right font-medium">Issued</td>
                    <td className="text-right">{formatDate(invoice.issueDate)}</td>
                  </tr>
                  <tr>
                    <td className="pr-3 text-right font-medium">Due</td>
                    <td className="text-right">{formatDate(invoice.dueDate)}</td>
                  </tr>
                  {invoice.poNumber ? (
                    <tr>
                      <td className="pr-3 text-right font-medium">PO</td>
                      <td className="text-right">{invoice.poNumber}</td>
                    </tr>
                  ) : null}
                  {invoice.pricingTierKey ? (
                    <tr>
                      <td className="pr-3 text-right font-medium">Terms</td>
                      <td className="text-right capitalize">
                        {invoice.pricingTierKey.replace(/_/g, ' ')}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </header>

          <section className="mt-6 flex items-start justify-between gap-8 text-xs">
            <div>
              <p className="mb-1 font-semibold tracking-wide text-gray-500 uppercase">Bill to</p>
              <p className="font-medium text-gray-900">{invoice.customerName}</p>
              <div className="leading-5 text-gray-700">
                {invoice.billLine1 ? <p>{invoice.billLine1}</p> : null}
                {invoice.billLine2 ? <p>{invoice.billLine2}</p> : null}
                <p>
                  {addressLines([invoice.billCity, invoice.billState])}
                  {invoice.billPostalCode ? ` ${invoice.billPostalCode}` : ''}
                </p>
              </div>
            </div>

            <div className="text-right">
              <p className="mb-1 font-semibold tracking-wide text-gray-500 uppercase">Ship to</p>
              <div className="leading-5 text-gray-700">
                {invoice.shipLine1 ? <p>{invoice.shipLine1}</p> : null}
                {invoice.shipLine2 ? <p>{invoice.shipLine2}</p> : null}
                <p>
                  {addressLines([invoice.shipCity, invoice.shipState])}
                  {invoice.shipPostalCode ? ` ${invoice.shipPostalCode}` : ''}
                </p>
              </div>
            </div>
          </section>

          <table className="mt-6 w-full border-collapse text-xs">
            <thead>
              <tr className="border-y border-gray-300 bg-gray-50">
                <th className="px-2 py-2 text-left font-semibold text-gray-600">Description</th>
                <th className="px-2 py-2 text-left font-semibold text-gray-600">Type</th>
                <th className="px-2 py-2 text-right font-semibold text-gray-600">Qty / Acres</th>
                <th className="px-2 py-2 text-right font-semibold text-gray-600">Unit price</th>
                <th className="px-2 py-2 text-right font-semibold text-gray-600">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-gray-200">
                  <td className="px-2 py-2 text-gray-900">{item.description}</td>
                  <td className="px-2 py-2 text-gray-600 capitalize">{item.lineType.replace(/_/g, ' ')}</td>
                  <td className="tabular px-2 py-2 text-right text-gray-700">
                    {item.acres ?? item.quantity} {item.unit ?? ''}
                  </td>
                  <td className="tabular px-2 py-2 text-right text-gray-700">
                    {formatCents(item.unitPriceCents)}
                  </td>
                  <td className="tabular px-2 py-2 text-right text-gray-900">
                    {formatCents(item.lineSubtotalCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <section className="avoid-break mt-4 ml-auto w-64 text-xs">
            <div className="flex justify-between border-b border-gray-200 py-1">
              <span className="text-gray-600">Subtotal</span>
              <span className="tabular">{formatCents(invoice.subtotalCents)}</span>
            </div>
            {invoice.discountCents > 0 ? (
              <div className="flex justify-between border-b border-gray-200 py-1">
                <span className="text-gray-600">Discount</span>
                <span className="tabular">−{formatCents(invoice.discountCents)}</span>
              </div>
            ) : null}
            <div className="flex justify-between border-b border-gray-200 py-1">
              <span className="text-gray-600">Tax</span>
              <span className="tabular">{formatCents(invoice.taxCents)}</span>
            </div>
            <div className="flex justify-between border-b-2 border-gray-400 py-1 text-sm font-semibold">
              <span>Total</span>
              <span className="tabular">{formatCents(invoice.totalCents)}</span>
            </div>
            {invoice.amountPaidCents > 0 ? (
              <div className="flex justify-between border-b border-gray-200 py-1">
                <span className="text-gray-600">Paid</span>
                <span className="tabular">{formatCents(invoice.amountPaidCents)}</span>
              </div>
            ) : null}
            <div className="flex justify-between py-1 text-sm font-semibold">
              <span>Balance due</span>
              <span className="tabular">{formatCents(invoice.balanceCents)}</span>
            </div>
          </section>

          {complianceTokens.length > 0 ? (
            <section className="avoid-break mt-6 border-t border-gray-200 pt-3 text-xs">
              <p className="mb-1 font-semibold tracking-wide text-gray-500 uppercase">
                Seed audit reference
              </p>
              <table className="w-full text-[10px] text-gray-700">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="py-1 pr-3 font-medium">Item</th>
                    <th className="py-1 pr-3 font-medium">BOL/CMR Number</th>
                    <th className="py-1 pr-3 font-medium">Order Number</th>
                    <th className="py-1 pr-3 font-medium">Seed NO.</th>
                    <th className="py-1 font-medium">Lot</th>
                  </tr>
                </thead>
                <tbody>
                  {complianceTokens.map((token) => (
                    <tr key={token.invoiceItemId}>
                      <td className="py-1 pr-3">{token.description}</td>
                      <td className="tabular py-1 pr-3">{token.bolCmrNumber ?? '—'}</td>
                      <td className="tabular py-1 pr-3">{token.orderNumber ?? '—'}</td>
                      <td className="tabular py-1 pr-3">{token.seedNumber ?? '—'}</td>
                      <td className="tabular py-1">{token.lotNumber ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          {invoice.notes ? (
            <section className="avoid-break mt-6 text-xs text-gray-700">
              <p className="mb-1 font-semibold tracking-wide text-gray-500 uppercase">Notes</p>
              <p className="whitespace-pre-line">{invoice.notes}</p>
            </section>
          ) : null}

          <footer className="mt-8 border-t border-gray-200 pt-3 text-[10px] leading-4 text-gray-500">
            <p>
              {company.legalName}
              {company.pesticideLicenseNumber ? ` · Pesticide licence ${company.pesticideLicenseNumber}` : ''}
            </p>
            <p>
              Please remit {formatCents(invoice.balanceCents)} by {formatDate(invoice.dueDate)}.
              {invoice.termsDays ? ` Terms net ${invoice.termsDays}.` : ''}
            </p>
            {!compliance.satisfied ? (
              <p className="text-gray-400">
                Draft — seed compliance not yet verified. Not valid for submission.
              </p>
            ) : null}
          </footer>
        </div>
      </div>
    </>
  );
}
