import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDb } from '../../db';
import { auditLogs, users } from '../../db/schema';
import type { AppEnv } from '../../env';
import { parseQuery } from '../lib/http';
import { requireAuth, requirePermission } from '../middleware';
import { auditListQuerySchema } from '../schemas';

/**
 * Administrative audit trail, read-only.
 *
 * Admin-only, enforced by the router rather than by hiding the nav link: the
 * trail contains actor IPs and change history for the whole business.
 *
 * There is deliberately no write or delete endpoint. An audit log you can edit
 * from the application is not an audit log.
 */
export const auditRoutes = new Hono<AppEnv>();

auditRoutes.use('*', requireAuth);
auditRoutes.use('*', requirePermission('admin:audit'));

auditRoutes.get('/', async (c) => {
  const { limit, offset, actorUserId, actorEmail, entityType, entityId, action, from, to } =
    parseQuery(new URL(c.req.url), auditListQuerySchema);
  const db = createDb(c.env.DB);

  const conditions: SQL[] = [];
  if (actorUserId) conditions.push(eq(auditLogs.actorUserId, actorUserId));
  // Filtering on the joined table is fine: the join is a left join, and an email
  // filter implies an actor, so rows without one are correctly excluded.
  if (actorEmail) conditions.push(eq(users.email, actorEmail));
  if (entityType) conditions.push(eq(auditLogs.entityType, entityType));
  if (entityId) conditions.push(eq(auditLogs.entityId, entityId));
  if (action) conditions.push(eq(auditLogs.action, action));
  if (from) conditions.push(gte(auditLogs.createdAt, from));
  if (to) conditions.push(lte(auditLogs.createdAt, to));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, counted] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        metadata: auditLogs.metadata,
        ipAddress: auditLogs.ipAddress,
        createdAt: auditLogs.createdAt,
        actorUserId: auditLogs.actorUserId,
        actorName: users.name,
        actorEmail: users.email,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset)
      .all(),
    db.select({ total: sql<number>`count(*)` }).from(auditLogs).where(where).get(),
  ]);

  return c.json({
    data: rows,
    pagination: { limit, offset, total: Number(counted?.total ?? 0) },
  });
});

/** Distinct values behind the filter controls, so they cannot drift from reality. */
auditRoutes.get('/facets', async (c) => {
  const db = createDb(c.env.DB);

  const [entityTypes, actions] = await Promise.all([
    db
      .selectDistinct({ value: auditLogs.entityType })
      .from(auditLogs)
      .orderBy(auditLogs.entityType)
      .all(),
    db.selectDistinct({ value: auditLogs.action }).from(auditLogs).orderBy(auditLogs.action).all(),
  ]);

  return c.json({
    data: {
      entityTypes: entityTypes.map((row) => row.value),
      actions: actions.map((row) => row.value),
    },
  });
});
