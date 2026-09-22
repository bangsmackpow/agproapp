import { Hono, type Context } from 'hono';

import { createDb } from '../../db';
import type { AppEnv } from '../../env';
import { requireAuth, requireCapability } from '../middleware';
import { parseJson, unauthorized } from '../lib/http';
import {
  priceTierUpdateSchema,
  serviceRateCreateSchema,
  serviceRateUpdateSchema,
  settingsUpdateSchema,
} from '../schemas';
import {
  createServiceRate,
  getSettings,
  listPriceTiers,
  listServiceRates,
  updatePriceTier,
  updateServiceRate,
  updateSettings,
} from '../../services/settings';

/**
 * Company settings and the editable pricing tables.
 *
 * Reads are available to any signed-in role — the invoice composer needs tiers and
 * service rates. Writes require `manageSettings`, which is Admin only, because
 * changing a multiplier changes what every future invoice charges.
 *
 * Handlers are deliberately *not* annotated as returning `Response`: that erases
 * the JSON type Hono uses to make the typed client work, and the loaders would be
 * back to hand-declared interfaces.
 */
export const settingsRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/', async (c) => {
    const db = createDb(c.env.DB);
    return c.json({ data: await getSettings(db) });
  })
  .patch('/', requireCapability('manageSettings'), async (c) => {
    const input = await parseJson(c.req.raw, settingsUpdateSchema);
    const db = createDb(c.env.DB);
    return c.json({ data: await updateSettings(db, input, actor(c)) });
  })
  .get('/price-tiers', async (c) => {
    const db = createDb(c.env.DB);
    return c.json({ data: await listPriceTiers(db) });
  })
  .patch('/price-tiers/:id', requireCapability('manageSettings'), async (c) => {
    const input = await parseJson(c.req.raw, priceTierUpdateSchema);
    const db = createDb(c.env.DB);
    return c.json({ data: await updatePriceTier(db, c.req.param('id'), input, actor(c)) });
  })
  .get('/service-rates', async (c) => {
    const db = createDb(c.env.DB);
    return c.json({ data: await listServiceRates(db) });
  })
  .post('/service-rates', requireCapability('manageSettings'), async (c) => {
    const input = await parseJson(c.req.raw, serviceRateCreateSchema);
    const db = createDb(c.env.DB);
    return c.json({ data: await createServiceRate(db, input) }, 201);
  })
  .patch('/service-rates/:id', requireCapability('manageSettings'), async (c) => {
    const input = await parseJson(c.req.raw, serviceRateUpdateSchema);
    const db = createDb(c.env.DB);
    return c.json({ data: await updateServiceRate(db, c.req.param('id'), input, actor(c)) });
  });

/**
 * `requireAuth` has already run, so a missing user is a bug rather than a 401 —
 * but failing loudly here beats writing an activity row attributed to nobody.
 */
function actor(c: Context<AppEnv>): { userId: string; ipAddress: string | null } {
  const user = c.get('user');
  if (!user) throw unauthorized();
  return { userId: user.id, ipAddress: c.req.header('cf-connecting-ip') ?? null };
}
