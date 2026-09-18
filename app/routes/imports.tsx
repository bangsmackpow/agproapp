import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

import {
  Alert,
  Badge,
  Button,
  CardHeader,
  EmptyRow,
  Field,
  Input,
  PageHeader,
  Select,
  Status,
  Table,
  Td,
  Th,
  statusTone,
} from '../components/ui';
import { api, getEnv, requireUser } from '../lib/api.server';
import { formatDate } from '../lib/utils';

export const meta = () => [{ title: 'Imports · AG Pro Solutions' }];

interface BatchRow {
  id: string;
  label: string;
  parserKey: string | null;
  docType: string;
  status: string;
  rowCount: number;
  committedCount: number;
  createdAt: number;
}

interface DraftRow {
  id: string;
  batchId: string;
  target: string;
  status: string;
  confidence: number | null;
  parsedPayload: Record<string, unknown> | null;
  issues: string[] | null;
}

interface ParserOption {
  key: string;
  label: string;
  documentType: string;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  await requireUser(env, request);

  const [parsers, batches] = await Promise.all([
    api<{ data: ParserOption[] }>(env, request, '/imports/parsers'),
    api<{ data: BatchRow[] }>(env, request, '/imports/batches?limit=25'),
  ]);

  // Show the drafts of the most recent batch — that is the one being reviewed.
  const latest = batches.data[0];
  const drafts = latest
    ? (await api<{ drafts: DraftRow[] }>(env, request, `/imports/batches/${latest.id}`)).drafts
    : [];

  return { parsers: parsers.data, batches: batches.data, latestId: latest?.id ?? null, drafts };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');

  try {
    if (intent === 'parse') {
      const parserKey = String(form.get('parserKey') ?? '').trim();
      await api(env, request, '/imports/batches', {
        method: 'POST',
        body: JSON.stringify({
          label: String(form.get('label') ?? '').trim() || 'Untitled import',
          ...(parserKey ? { parserKey } : {}),
          text: String(form.get('text') ?? ''),
        }),
      });
      return { ok: 'Parsed. Review the staged rows below, then commit.' };
    }

    if (intent === 'accept' || intent === 'reject') {
      await api(env, request, `/imports/drafts/${String(form.get('draftId') ?? '')}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: intent === 'accept' ? 'accepted' : 'rejected' }),
      });
      return { ok: intent === 'accept' ? 'Row accepted.' : 'Row rejected.' };
    }

    if (intent === 'commit') {
      const result = await api<{ committed: unknown[]; skipped: unknown[] }>(
        env,
        request,
        `/imports/batches/${String(form.get('batchId') ?? '')}/commit`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      return {
        ok: `Committed ${result.committed.length} row(s); ${result.skipped.length} skipped.`,
      };
    }

    return { error: 'Unknown action.' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That action failed.' };
  }
}

export default function ImportsRoute() {
  const { parsers, batches, latestId, drafts } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();

  const acceptable = drafts.filter((draft) => draft.status === 'accepted' || draft.status === 'edited');

  return (
    <>
      <PageHeader
        title="Document imports"
        description="Paste the extracted text of a vendor document. Nothing reaches inventory until you commit it."
      />

      {result?.error ? (
        <div className="mb-4">
          <Alert title={result.error} />
        </div>
      ) : null}
      {result?.ok ? (
        <div className="mb-4">
          <Alert tone="info" title={result.ok} />
        </div>
      ) : null}

      <div className="space-y-3">
        <div className="rounded-md border border-border">
          <CardHeader
            title="Review queue"
            description={
              latestId
                ? `${drafts.length} staged row(s) in the most recent batch`
                : 'No batch parsed yet'
            }
            actions={
              latestId ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="commit" />
                  <input type="hidden" name="batchId" value={latestId} />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={acceptable.length === 0 || navigation.state === 'submitting'}
                  >
                    Commit accepted ({acceptable.length})
                  </Button>
                </Form>
              ) : undefined
            }
          />
          <Table>
            <thead>
              <tr>
                <Th>Target</Th>
                <Th>Extracted</Th>
                <Th className="text-right">Confidence</Th>
                <Th>Issues</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {drafts.length === 0 ? (
                <EmptyRow colSpan={6} message="Nothing staged. Parse a document to begin." />
              ) : (
                drafts.map((draft) => (
                  <tr key={draft.id}>
                    <Td>
                      <Badge tone="neutral">{draft.target}</Badge>
                    </Td>
                    <Td className="max-w-md truncate text-xs">
                      {String(
                        (draft.parsedPayload?.description as string) ??
                          (draft.parsedPayload?.billNumber as string) ??
                          '—',
                      )}
                      {draft.parsedPayload?.bolCmrNumber ? (
                        <span className="ml-2 tabular">
                          BOL {String(draft.parsedPayload.bolCmrNumber)}
                        </span>
                      ) : null}
                      {draft.parsedPayload?.orderNumber ? (
                        <span className="ml-2 tabular">
                          Order {String(draft.parsedPayload.orderNumber)}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="tabular text-right">
                      {draft.confidence === null ? '—' : `${Math.round(draft.confidence * 100)}%`}
                    </Td>
                    <Td>
                      {draft.issues && draft.issues.length > 0 ? (
                        <Badge tone="warning">{draft.issues.length}</Badge>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td>
                      <Status tone={statusTone(draft.status)}>{draft.status}</Status>
                    </Td>
                    <Td>
                      {draft.status === 'pending' ? (
                        <div className="flex gap-2">
                          <Form method="post">
                            <input type="hidden" name="intent" value="accept" />
                            <input type="hidden" name="draftId" value={draft.id} />
                            <Button type="submit" size="sm" variant="secondary">
                              Accept
                            </Button>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="intent" value="reject" />
                            <input type="hidden" name="draftId" value={draft.id} />
                            <Button type="submit" size="sm" variant="ghost">
                              Reject
                            </Button>
                          </Form>
                        </div>
                      ) : null}
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </div>

        <div className="space-y-6">
          <div className="rounded-md border border-border">
            <CardHeader title="Parse a document" description="Text, not the image" />
            <Form method="post" className="space-y-2 p-3">
              <input type="hidden" name="intent" value="parse" />
              <Field label="Label">
                <Input name="label" placeholder="Wickman invoice 103935" />
              </Field>
              <Field label="Parser" hint="Leave on auto-detect unless the layout is ambiguous">
                <Select name="parserKey" defaultValue="">
                  <option value="">Auto-detect</option>
                  {parsers.map((parser) => (
                    <option key={parser.key} value={parser.key}>
                      {parser.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Extracted text">
                <textarea
                  name="text"
                  required
                  rows={10}
                  placeholder="Paste the document text here…"
                  className="w-full rounded-md border border-border bg-surface p-3 font-mono text-xs text-ink"
                />
              </Field>
              <Button type="submit" className="w-full" disabled={navigation.state === 'submitting'}>
                {navigation.state === 'submitting' ? 'Parsing…' : 'Parse and stage'}
              </Button>
            </Form>
          </div>

          <div className="rounded-md border border-border">
            <CardHeader title="Recent batches" />
            <Table>
              <thead>
                <tr>
                  <Th>Label</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Committed</Th>
                </tr>
              </thead>
              <tbody>
                {batches.length === 0 ? (
                  <EmptyRow colSpan={3} message="No batches." />
                ) : (
                  batches.map((batch) => (
                    <tr key={batch.id}>
                      <Td>
                        {batch.label}
                        <span className="block text-xs text-ink-muted">
                          {batch.parserKey ?? 'manual'} · {formatDate(batch.createdAt)}
                        </span>
                      </Td>
                      <Td>
                        <Status tone={statusTone(batch.status)}>{batch.status}</Status>
                      </Td>
                      <Td className="tabular text-right">
                        {batch.committedCount}/{batch.rowCount}
                      </Td>
                    </tr>
                  ))
                )}
              </tbody>
            </Table>
          </div>
        </div>
      </div>
    </>
  );
}
