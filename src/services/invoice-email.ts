import { formatUsd } from '../shared/pricing';

/**
 * Invoice email composition.
 *
 * Pure: it takes data and returns a message, so the wording can be asserted in a
 * test rather than discovered in a customer's inbox. The body is a summary with a
 * link rather than a full HTML reproduction of the invoice — the printable view
 * is the document of record, and duplicating its markup here would guarantee the
 * two drift apart.
 */

export interface InvoiceEmailInvoice {
  invoiceNumber: string;
  customerName: string;
  issueDate: Date;
  dueDate: Date | null;
  totalCents: number;
  amountPaidCents: number;
  balanceCents: number;
  termsDays: number | null;
  poNumber: string | null;
}

export interface InvoiceEmailCompany {
  displayName: string;
  legalName: string;
  phone: string | null;
  email: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

export interface InvoiceEmailTokens {
  bolCmrNumber: string | null;
  orderNumber: string | null;
}

export interface ComposeInvoiceEmailInput {
  invoice: InvoiceEmailInvoice;
  company: InvoiceEmailCompany;
  itemCount: number;
  invoiceUrl: string;
  complianceTokens: InvoiceEmailTokens[];
}

export interface ComposedEmail {
  subject: string;
  text: string;
  html: string;
}

function formatDay(value: Date | null): string {
  if (!value) return 'receipt';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long' }).format(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function composeInvoiceEmail(input: ComposeInvoiceEmailInput): ComposedEmail {
  const { invoice, company, itemCount, invoiceUrl, complianceTokens } = input;

  const subject = `${company.displayName} invoice ${invoice.invoiceNumber} — ${formatUsd(
    invoice.balanceCents,
  )} due ${formatDay(invoice.dueDate)}`;

  const remit = [company.addressLine1, [company.city, company.state].filter(Boolean).join(', ')]
    .filter((part) => Boolean(part && part.trim()))
    .join(', ');

  const tokenLines = complianceTokens
    .filter((token) => token.bolCmrNumber || token.orderNumber)
    .map(
      (token) =>
        `  • BOL/CMR Number ${token.bolCmrNumber ?? '—'} · Order Number ${token.orderNumber ?? '—'}`,
    );

  const text = [
    `${invoice.customerName},`,
    '',
    `Please find invoice ${invoice.invoiceNumber} dated ${formatDay(invoice.issueDate)}.`,
    '',
    `  Line items:    ${itemCount}`,
    `  Total:         ${formatUsd(invoice.totalCents)}`,
    ...(invoice.amountPaidCents > 0 ? [`  Paid:          ${formatUsd(invoice.amountPaidCents)}`] : []),
    `  Balance due:   ${formatUsd(invoice.balanceCents)}`,
    `  Due date:      ${formatDay(invoice.dueDate)}${invoice.termsDays ? ` (net ${invoice.termsDays})` : ''}`,
    ...(invoice.poNumber ? [`  Your PO:       ${invoice.poNumber}`] : []),
    '',
    `View or print the invoice: ${invoiceUrl}`,
    ...(tokenLines.length > 0
      ? ['', 'Seed audit reference (State of Iowa):', ...tokenLines]
      : []),
    '',
    `Thank you,`,
    `${company.displayName}`,
    ...(remit ? [remit] : []),
    ...(company.phone ? [company.phone] : []),
    ...(company.email ? [company.email] : []),
  ].join('\n');

  const row = (label: string, value: string, bold = false) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#4b5563">${escapeHtml(label)}</td><td style="text-align:right;${
      bold ? 'font-weight:600;' : ''
    }">${escapeHtml(value)}</td></tr>`;

  const html = `<!doctype html>
<html><body style="font-family:Helvetica,Arial,sans-serif;color:#111827;font-size:14px;line-height:1.5">
  <p>${escapeHtml(invoice.customerName)},</p>
  <p>Please find invoice <strong>${escapeHtml(invoice.invoiceNumber)}</strong> dated ${escapeHtml(
    formatDay(invoice.issueDate),
  )}.</p>
  <table style="border-collapse:collapse;margin:12px 0">
    ${row('Line items', String(itemCount))}
    ${row('Total', formatUsd(invoice.totalCents))}
    ${invoice.amountPaidCents > 0 ? row('Paid', formatUsd(invoice.amountPaidCents)) : ''}
    ${row('Balance due', formatUsd(invoice.balanceCents), true)}
    ${row('Due date', `${formatDay(invoice.dueDate)}${invoice.termsDays ? ` (net ${invoice.termsDays})` : ''}`)}
    ${invoice.poNumber ? row('Your PO', invoice.poNumber) : ''}
  </table>
  <p><a href="${escapeHtml(invoiceUrl)}" style="color:#2f6b4f">View or print the invoice</a></p>
  ${
    tokenLines.length > 0
      ? `<p style="color:#4b5563;font-size:12px">Seed audit reference (State of Iowa):</p><ul style="color:#4b5563;font-size:12px">${complianceTokens
          .filter((token) => token.bolCmrNumber || token.orderNumber)
          .map(
            (token) =>
              `<li>BOL/CMR Number ${escapeHtml(token.bolCmrNumber ?? '—')} · Order Number ${escapeHtml(
                token.orderNumber ?? '—',
              )}</li>`,
          )
          .join('')}</ul>`
      : ''
  }
  <p>Thank you,<br/>${escapeHtml(company.displayName)}${
    remit ? `<br/><span style="color:#4b5563;font-size:12px">${escapeHtml(remit)}</span>` : ''
  }</p>
</body></html>`;

  return { subject, text, html };
}
