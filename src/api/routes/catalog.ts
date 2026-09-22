import { Hono } from 'hono';

import { createDb } from '../../db';
import type { AppEnv } from '../../env';
import {
  adjustStock,
  createProduct,
  createVendor,
  getProductDetail,
  listProducts,
  listVendors,
  lowStockProducts,
  receiveStock,
  updateProduct,
  updateVendor,
} from '../../services/catalog';
import { parseJson, parseQuery } from '../lib/http';
import { actorOf, requireAuth, requireCapability } from '../middleware';
import {
  catalogListQuerySchema,
  productCreateSchema,
  productUpdateSchema,
  stockAdjustSchema,
  stockReceiptSchema,
  vendorCreateSchema,
  vendorListQuerySchema,
  vendorUpdateSchema,
} from '../schemas';

/**
 * Catalog, stock, and vendors.
 *
 * Reads are open to any signed-in role: a rep quoting an invoice has to see what
 * is on the shelf. Writes split along the two capabilities that matter in the
 * field — `manageCatalog` changes what a product *is* (its cost, its unit,
 * whether it is regulated seed), while `manageStock` only moves quantity, which is
 * what someone at the barn is actually able to do.
 */
export const catalogRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)

  .get('/products', async (c) => {
    const query = parseQuery(new URL(c.req.url), catalogListQuerySchema);
    const db = createDb(c.env.DB);
    const page = await listProducts(db, query);

    return c.json({
      data: page.rows,
      pagination: { limit: page.limit, offset: page.offset, total: page.total },
    });
  })

  .post('/products', requireCapability('manageCatalog'), async (c) => {
    const input = await parseJson(c.req.raw, productCreateSchema);
    const db = createDb(c.env.DB);
    return c.json({ data: await createProduct(db, input, actorOf(c)) }, 201);
  })

  /* Declared after the two-segment paths so those are never read as a record id. */
  .get('/products/:id/ledger', async (c) => {
    const db = createDb(c.env.DB);
    const { ledger } = await getProductDetail(db, c.req.param('id'));
    return c.json({ data: ledger });
  })

  .post('/products/:id/receipts', requireCapability('manageStock'), async (c) => {
    const input = await parseJson(c.req.raw, stockReceiptSchema);
    const db = createDb(c.env.DB);
    return c.json({ data: await receiveStock(db, c.req.param('id'), input, actorOf(c)) }, 201);
  })

  .post('/products/:id/adjustments', requireCapability('manageStock'), async (c) => {
    const input = await parseJson(c.req.raw, stockAdjustSchema);
    const db = createDb(c.env.DB);
    return c.json({ data: await adjustStock(db, c.req.param('id'), input, actorOf(c)) }, 201);
  })

  .get('/products/:id', async (c) => {
    const db = createDb(c.env.DB);
    return c.json(await getProductDetail(db, c.req.param('id')));
  })

  .patch('/products/:id', requireCapability('manageCatalog'), async (c) => {
    const input = await parseJson(c.req.raw, productUpdateSchema);
    const db = createDb(c.env.DB);
    return c.json({ data: await updateProduct(db, c.req.param('id'), input, actorOf(c)) });
  })

  /** The needs-ordering set, for the dashboard panel and the email digest. */
  .get('/inventory/low', async (c) => {
    const db = createDb(c.env.DB);
    return c.json({ data: await lowStockProducts(db) });
  })

  .get('/vendors', async (c) => {
    const { includeInactive } = parseQuery(new URL(c.req.url), vendorListQuerySchema);
    const db = createDb(c.env.DB);
    return c.json({ data: await listVendors(db, includeInactive) });
  })

  .post('/vendors', requireCapability('manageCatalog'), async (c) => {
    const input = await parseJson(c.req.raw, vendorCreateSchema);
    const db = createDb(c.env.DB);
    return c.json({ data: await createVendor(db, input) }, 201);
  })

  .patch('/vendors/:id', requireCapability('manageCatalog'), async (c) => {
    const input = await parseJson(c.req.raw, vendorUpdateSchema);
    const db = createDb(c.env.DB);
    return c.json({ data: await updateVendor(db, c.req.param('id'), input, actorOf(c)) });
  });
