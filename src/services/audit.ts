import type { Database } from '../db';
import { auditLogs } from '../db/schema';

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
