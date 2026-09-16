import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDb } from '../../db';
import { importBatches, importDrafts } from '../../db/schema';
import type { AppEnv } from '../../env';
import { notFound, parseJson, parseQuery } from '../lib/http';
import { requireAuth, requirePermission } from '../middleware';
import {
  importBatchCreateSchema,
  importCommitSchema,
  importDraftUpdateSchema,
  listQuerySchema,
} from '../schemas';
import { commitBatch, rejectBatch, stageDrafts } from '../../services/imports';
import { listParsers, parseDocument } from '../../services/parsers/registry';

/**
 * Document ingestion.
 *
 * The endpoint accepts *extracted text*, runs it through the parser registry, and
 * stages the result in the review queue. Nothing reaches live inventory from
 * here — committing is a separate, explicit, audited call.
 */
export const importRoutes = new Hono<AppEnv>();

importRoutes.use('*', requireAuth);

importRoutes.get('/parsers', requirePermission('inventory:import'), (c) =>
  c.json({ data: listParsers() }),
);

/** Parse a document and stage its rows for review. */
importRoutes.post('/batches', requirePermission('inventory:import'), async (c) => {
  const input = await parseJson(c.req.raw, importBatchCreateSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  const parsed = parseDocument(input.text, { parserKey: input.parserKey });
  const staged = stageDrafts(parsed, { vendorId: input.vendorId });

  const [batch] = await db
    .insert(importBatches)
    .values({
      label: input.label,
      vendorId: input.vendorId ?? null,
      docType: input.docType ?? parsed.documentType,
      parserKey: parsed.parserKey,
      status: 'in_review',
      rowCount: staged.length,
      uploadedByUserId: actor.id,
    })
    .returning();

  if (!batch) throw notFound('Failed to create import batch');

  if (staged.length > 0) {
    await db.insert(importDrafts).values(
      staged.map((draft) => ({
        batchId: batch.id,
        target: draft.target,
        lineNumber: draft.lineNumber ?? null,
        confidence: draft.confidence,
        parsedPayload: draft.parsedPayload,
        rawPayload: draft.rawPayload ?? null,
        issues: draft.issues ?? null,
      })),
    );
  }

  return c.json(
    {
      data: batch,
      parsed: {
        parserKey: parsed.parserKey,
        vendorCode: parsed.vendorCode,
        documentType: parsed.documentType,
        confidence: parsed.confidence,
        header: parsed.header,
        warnings: parsed.warnings,
        lineItemCount: parsed.lineItems.length,
      },
    },
    201,
  );
});

importRoutes.get('/batches', requirePermission('inventory:read'), async (c) => {
  const { limit, offset } = parseQuery(new URL(c.req.url), listQuerySchema);
  const db = createDb(c.env.DB);

  const rows = await db
    .select()
    .from(importBatches)
    .orderBy(desc(importBatches.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  return c.json({ data: rows, pagination: { limit, offset } });
});

importRoutes.get('/batches/:id', requirePermission('inventory:read'), async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param('id');

  const batch = await db.select().from(importBatches).where(eq(importBatches.id, id)).get();
  if (!batch) throw notFound('Import batch not found');

  const drafts = await db
    .select()
    .from(importDrafts)
    .where(eq(importDrafts.batchId, id))
    .orderBy(importDrafts.lineNumber)
    .all();

  return c.json({ data: batch, drafts });
});

/** Correct a staged row before committing it. */
importRoutes.patch('/drafts/:id', requirePermission('inventory:import'), async (c) => {
  const input = await parseJson(c.req.raw, importDraftUpdateSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  const [updated] = await db
    .update(importDrafts)
    .set({
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.parsedPayload === undefined ? {} : { parsedPayload: input.parsedPayload }),
      ...(input.status === undefined ? {} : { status: input.status }),
      reviewedByUserId: actor.id,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(importDrafts.id, c.req.param('id')))
    .returning();

  if (!updated) throw notFound('Import draft not found');
  return c.json({ data: updated });
});

/**
 * Commit reviewed rows to their target tables. Commits only drafts that are
 * `accepted` or `edited` unless explicit ids are supplied.
 */
importRoutes.post('/batches/:id/commit', requirePermission('inventory:import'), async (c) => {
  const input = await parseJson(c.req.raw, importCommitSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  const result = await commitBatch(db, c.req.param('id'), {
    draftIds: input.draftIds,
    actorUserId: actor.id,
  });

  return c.json({ data: result });
});

importRoutes.post('/batches/:id/reject', requirePermission('inventory:import'), async (c) => {
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  const batch = await rejectBatch(db, c.req.param('id'), actor.id);
  return c.json({ data: batch });
});
