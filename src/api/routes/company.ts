import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDb } from '../../db';
import { companySettings, type CompanySettings } from '../../db/schema';
import type { AppEnv } from '../../env';
import { resolveCheckTemplate } from '../../shared/check-template';
import { conflict, parseJson } from '../lib/http';
import { requireAuth, requirePermission } from '../middleware';
import { companySettingsUpdateSchema } from '../schemas';
import { recordChange } from '../../services/audit';

/**
 * Company identity, as it appears on printed invoices and cheques.
 *
 * A single row, created on first read. `company_settings` has no natural key, so
 * "the singleton" is defined as the first row in insertion order.
 */
export const companyRoutes = new Hono<AppEnv>();

companyRoutes.use('*', requireAuth);

async function loadSettings(db: ReturnType<typeof createDb>): Promise<CompanySettings> {
  const existing = await db.select().from(companySettings).limit(1).get();
  if (existing) return existing;

  const [created] = await db.insert(companySettings).values({}).returning();
  if (!created) throw conflict('Failed to initialise company settings');
  return created;
}

companyRoutes.get('/', async (c) => {
  const db = createDb(c.env.DB);
  return c.json({ data: await loadSettings(db) });
});

companyRoutes.patch('/', requirePermission('admin:settings'), async (c) => {
  const input = await parseJson(c.req.raw, companySettingsUpdateSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');
  const current = await loadSettings(db);

  const { checkTemplateConfig, ...rest } = input;

  const patch: Partial<typeof companySettings.$inferInsert> = {
    ...rest,
    // Normalise rather than trust: this is hand-edited geometry.
    ...(checkTemplateConfig
      ? { checkTemplateConfig: resolveCheckTemplate(checkTemplateConfig) }
      : {}),
    updatedAt: new Date(),
  };

  const [updated] = await db
    .update(companySettings)
    .set(patch)
    .where(eq(companySettings.id, current.id))
    .returning();

  if (!updated) throw conflict('Failed to update company settings');

  const changes = await recordChange(db, {
    actorUserId: actor.id,
    action: 'company_settings.updated',
    entityType: 'company_settings',
    entityId: updated.id,
    before: current,
    after: updated,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ data: updated, changes });
});
