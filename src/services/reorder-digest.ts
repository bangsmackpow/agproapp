import { and, asc, eq } from 'drizzle-orm';

import { createDb } from '../db';
import { settings as settingsTable, users } from '../db/schema';
import type { Env } from '../env';
import { lowStockProducts } from './catalog';
import { getSettings } from './settings';
import { createMailer } from './mailer';
import { recordAudit } from './audit';
import { formatUsd } from '../shared/pricing';

/**
 * The morning low-stock email.
 *
 * "Notify us when we need to order something" has two halves: the dashboard panel
 * (which is only useful once someone opens the app) and this, which reaches them
 * without being asked. The cron fires at 13:00 UTC — 7am Central year-round — so
 * the list is there before the trucks leave.
 *
 * Two guards worth stating:
 *
 * • **Once per day, in the database.** `settings.lastDigestAt` is claimed before
 *   sending, because a cron retry would otherwise mail the same list twice before
 *   breakfast, and a digest that repeats stops being trusted.
 * • **Nothing to report is nothing to send.** An empty email trains people to
 *   ignore the subject line, so a quiet morning stays quiet.
 *
 * With no mail provider configured the send reports `skipped` rather than
 * pretending, which is the same honesty the invoice delivery already uses.
 */
export interface DigestOutcome {
  status: 'sent' | 'skipped' | 'failed' | 'nothing' | 'already-sent-today';
  productCount: number;
  recipients: number;
  error?: string;
}

const SAME_DAY_MS = 20 * 60 * 60 * 1000;

export async function runReorderDigest(env: Env): Promise<DigestOutcome> {
  const db = createDb(env.DB);
  const settings = await getSettings(db);
  const now = new Date();

  // A generous same-window rather than a calendar-date comparison: what matters is
  // "not twice today", and the worker's clock is UTC while the intent is local.
  if (settings.lastDigestAt && now.getTime() - settings.lastDigestAt.getTime() < SAME_DAY_MS) {
    return { status: 'already-sent-today', productCount: 0, recipients: 0 };
  }

  const low = await lowStockProducts(db);
  if (low.length === 0) {
    return { status: 'nothing', productCount: 0, recipients: 0 };
  }

  const recipients = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(and(eq(users.isActive, true), eq(users.role, 'admin')))
    .orderBy(asc(users.name))
    .all();

  if (recipients.length === 0) {
    return { status: 'nothing', productCount: low.length, recipients: 0 };
  }

  // Claim the slot before sending: a crash mid-send should lose a day's digest,
  // not produce two.
  await db.update(settingsTable).set({ lastDigestAt: now }).where(eq(settingsTable.id, settings.id));

  const subject = `${low.length} item${low.length === 1 ? '' : 's'} to reorder — AG Pro Solutions`;
  const text = renderText(subject, low);
  const html = renderHtml(subject, low);
  const mailer = createMailer(env);

  let status: DigestOutcome['status'] = 'sent';
  let error: string | undefined;

  for (const recipient of recipients) {
    const result = await mailer.send({
      to: recipient.email,
      subject,
      text,
      html,
      replyTo: env.MAIL_REPLY_TO || undefined,
      from: env.MAIL_FROM || undefined,
    });

    if (!result.ok) {
      status = result.skipped ? 'skipped' : 'failed';
      error = result.error;
    }
  }

  await recordAudit(db, {
    action: 'digest.reorder',
    entityType: 'system',
    entityId: null,
    metadata: { status, products: low.length, recipients: recipients.length, error: error ?? null },
  });

  return { status, productCount: low.length, recipients: recipients.length, ...(error ? { error } : {}) };
}

type Row = Awaited<ReturnType<typeof lowStockProducts>>[number];

function renderText(subject: string, rows: readonly Row[]): string {
  const lines = rows.map((row) => {
    const cost = row.costCents === null ? 'no cost on file' : `${formatUsd(row.costCents)} current cost`;
    const vendor = row.vendorName ? ` — order from ${row.vendorName}` : ' — no vendor on file';
    return `• ${row.name} (${row.sku}): ${row.quantityOnHand} ${row.unit} on hand, reorder point ${row.reorderPoint ?? 0}, order ${row.reorderQuantity ?? 'an amount you choose'}${vendor}. ${cost}.`;
  });

  return [
    subject,
    '',
    ...lines,
    '',
    'Open the inventory screen to receive what arrives. Quantities come from the stock ledger, so these figures are what the books actually say.',
  ].join('\n');
}

function renderHtml(subject: string, rows: readonly Row[]): string {
  const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, (character) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character;
    });

  const body = rows
    .map((row) => {
      return `<tr>
        <td style="padding:6px 12px 6px 0">${escapeHtml(row.name)}</td>
        <td style="padding:6px 12px 6px 0">${escapeHtml(row.sku)}</td>
        <td style="padding:6px 12px 6px 0;text-align:right">${row.quantityOnHand} ${escapeHtml(row.unit)}</td>
        <td style="padding:6px 12px 6px 0;text-align:right">${row.reorderPoint ?? 0}</td>
        <td style="padding:6px 12px 6px 0;text-align:right">${row.reorderQuantity ?? '—'}</td>
        <td style="padding:6px 12px 6px 0">${escapeHtml(row.vendorName ?? '—')}</td>
      </tr>`;
    })
    .join('');

  return `<p>${escapeHtml(subject)}</p>
<table style="border-collapse:collapse;font-size:13px" cellpadding="0" cellspacing="0">
  <thead><tr>
    ${['Item', 'SKU', 'On hand', 'Reorder point', 'Suggested qty', 'Vendor']
      .map((label) => `<th style="text-align:left;border-bottom:1px solid #d1d9e0;padding:6px 12px 6px 0">${label}</th>`)
      .join('')}
  </tr></thead>
  <tbody>${body}</tbody>
</table>
<p>Open the inventory screen to receive what arrives. Quantities come from the stock ledger, so these figures are what the books actually say.</p>`;
}
