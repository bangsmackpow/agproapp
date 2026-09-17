import type { Database } from '../db';
import { auditLogs } from '../db/schema';

/**
 * Administrative audit trail.
 *
 * Entries record *what changed*, not merely that something did: storing a diff of
 * the changed fields is what makes a question like "who switched this product
 * from gallons to ounces, and when" answerable. Only changed fields are stored,
 * so an audit row stays small even when a form submits twenty fields.
 */

export interface FieldChange {
  from: unknown;
  to: unknown;
}

/**
 * Fields never worth recording, because they change on every write.
 * `updatedAt` differing on every update would make every row look interesting.
 */
const IGNORED_FIELDS = new Set(['updatedAt', 'updated_at', 'createdAt', 'created_at']);

/**
 * Keys whose values must never reach the audit log. A diff of a user record
 * would otherwise write password hashes into a table that is read by the audit
 * viewer — an excellent way to leak the whole credential store.
 */
const REDACTED_KEY = /password|secret|token|hash|api_?key/i;

export type FieldDiff = Record<string, FieldChange>;

function comparable(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return String(value.getTime());
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function redact(value: unknown): unknown {
  return value === null || value === undefined ? value : '[redacted]';
}

/**
 * Compares two row snapshots and returns only the fields that differ.
 *
 * Iterates `after`, so a partial update reports just the fields it wrote rather
 * than every column on the row.
 */
export function diffFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  options: { ignore?: readonly string[] } = {},
): FieldDiff {
  if (!after) return {};

  const ignore = new Set([...IGNORED_FIELDS, ...(options.ignore ?? [])]);
  const diff: FieldDiff = {};

  for (const [key, next] of Object.entries(after)) {
    if (ignore.has(key)) continue;

    const previous = before ? (before as Record<string, unknown>)[key] : undefined;
    if (comparable(previous) === comparable(next)) continue;

    diff[key] = REDACTED_KEY.test(key)
      ? { from: redact(previous), to: redact(next) }
      : { from: previous ?? null, to: next ?? null };
  }

  return diff;
}

/**
 * Appends to the administrative audit trail.
 *
 * Never throws: an audit write must not be able to fail the business operation it
 * is describing. Failures are logged and swallowed instead.
 */
export async function recordAudit(
  db: Database,
  entry: {
    actorUserId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
    ipAddress?: string | null;
  },
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata ?? null,
      ipAddress: entry.ipAddress ?? null,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'warn',
        message: 'audit write failed',
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * Records an update, with a diff instead of a bare field list.
 *
 * Returns the diff so a caller can report it. Writes nothing when no field
 * actually changed — a save that changes nothing is not an event.
 */
export async function recordChange(
  db: Database,
  entry: {
    actorUserId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    before: Record<string, unknown> | null | undefined;
    after: Record<string, unknown> | null | undefined;
    ignore?: readonly string[];
    metadata?: Record<string, unknown>;
    ipAddress?: string | null;
  },
): Promise<FieldDiff> {
  const changes = diffFields(entry.before, entry.after, { ignore: entry.ignore });
  if (Object.keys(changes).length === 0) return {};

  await recordAudit(db, {
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    metadata: { changes, ...entry.metadata },
    ipAddress: entry.ipAddress,
  });

  return changes;
}
