import { Form, Link, useLoaderData, useSearchParams } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';

import {
  Badge,
  Card,
  CardHeader,
  EmptyRow,
  Input,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
} from '../components/ui';
import { api, assertPermission, getEnv, requireUser } from '../lib/api.server';
import { formatDate } from '../lib/utils';

export const meta = () => [{ title: 'Audit trail · AG Pro Solutions' }];

interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: number;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
}

interface Facets {
  entityTypes: string[];
  actions: string[];
}

const PAGE_SIZE = 50;

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);
  // Admin-only: the trail carries actor IPs and change history for the business.
  assertPermission(user, 'admin:audit');

  const url = new URL(request.url);
  const passThrough = ['entityType', 'action', 'actorEmail', 'from', 'to'];
  const params = new URLSearchParams();

  for (const key of passThrough) {
    const value = url.searchParams.get(key);
    if (value) params.set(key, value);
  }

  const offset = Number(url.searchParams.get('offset') ?? 0);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));

  const [events, facets] = await Promise.all([
    api<{ data: AuditRow[]; pagination: { total: number } }>(env, request, `/audit?${params}`),
    api<{ data: Facets }>(env, request, '/audit/facets'),
  ]);

  return {
    events: events.data,
    facets: facets.data,
    total: events.pagination.total,
    offset,
    pageSize: PAGE_SIZE,
  };
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

interface Change {
  from: unknown;
  to: unknown;
}

/** Renders the changed fields of an update as before → after. */
function ChangeList({ changes }: { changes: Record<string, Change> }) {
  const entries = Object.entries(changes);

  return (
    <ul className="space-y-0.5 text-xs">
      {entries.map(([field, change]) => (
        <li key={field}>
          <span className="font-medium text-ink">{field}</span>{' '}
          <span className="text-ink-muted line-through">{formatValue(change.from)}</span>{' '}
          <span className="text-ink-muted">→</span>{' '}
          <span className="text-ink">{formatValue(change.to)}</span>
        </li>
      ))}
    </ul>
  );
}

export default function AuditRoute() {
  const { events, facets, total, offset, pageSize } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();

  const page = Math.floor(offset / pageSize) + 1;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const pageLink = (nextOffset: number) => {
    const next = new URLSearchParams(params);
    next.set('offset', String(nextOffset));
    return `?${next}`;
  };

  return (
    <>
      <PageHeader
        title="Audit trail"
        description={`${total} recorded event${total === 1 ? '' : 's'}, newest first. Append-only; nothing here is edited or deleted.`}
      />

      <Card className="mb-6">
        <CardHeader title="Filter" description="Narrow by who, what, or when" />
        <Form method="get" className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink">Entity type</span>
            <Select name="entityType" defaultValue={params.get('entityType') ?? ''}>
              <option value="">Any</option>
              {facets.entityTypes.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink">Action</span>
            <Select name="action" defaultValue={params.get('action') ?? ''}>
              <option value="">Any</option>
              {facets.actions.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink">Actor email</span>
            <Input
              type="email"
              name="actorEmail"
              defaultValue={params.get('actorEmail') ?? ''}
              placeholder="anyone"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink">From</span>
            <Input type="date" name="from" defaultValue={params.get('from') ?? ''} />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink">To</span>
            <Input type="date" name="to" defaultValue={params.get('to') ?? ''} />
          </label>

          <div className="flex items-end gap-2">
            <button
              type="submit"
              className="h-10 rounded-md bg-brand-700 px-4 text-sm font-medium text-white"
            >
              Apply
            </button>
            <Link className="h-10 px-3 py-2 text-sm text-brand-700 underline" to="/audit">
              Reset
            </Link>
          </div>
        </Form>
      </Card>

      <Card>
        <CardHeader
          title="Events"
          description={`Page ${page} of ${pages}`}
          actions={
            <div className="flex items-center gap-2">
              {offset > 0 ? (
                <Link
                  className="rounded-md bg-white px-3 py-1.5 text-sm text-ink ring-1 ring-border"
                  to={pageLink(Math.max(0, offset - pageSize))}
                >
                  Newer
                </Link>
              ) : null}
              {offset + pageSize < total ? (
                <Link
                  className="rounded-md bg-white px-3 py-1.5 text-sm text-ink ring-1 ring-border"
                  to={pageLink(offset + pageSize)}
                >
                  Older
                </Link>
              ) : null}
            </div>
          }
        />
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Who</Th>
              <Th>Action</Th>
              <Th>Entity</Th>
              <Th>Change</Th>
              <Th>From</Th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <EmptyRow colSpan={6} message="No events match those filters." />
            ) : (
              events.map((event) => {
                const changes = (event.metadata?.changes ?? null) as Record<string, Change> | null;

                return (
                  <tr key={event.id}>
                    <Td className="whitespace-nowrap">{formatDate(event.createdAt)}</Td>
                    <Td>
                      {event.actorName ?? <span className="text-ink-muted">system</span>}
                      {event.actorEmail ? (
                        <span className="block text-xs text-ink-muted">{event.actorEmail}</span>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone="neutral">{event.action}</Badge>
                    </Td>
                    <Td>
                      {event.entityType}
                      {event.entityId ? (
                        <span className="block font-mono text-[10px] text-ink-muted">
                          {event.entityId.slice(0, 8)}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      {changes ? (
                        <ChangeList changes={changes} />
                      ) : (
                        <span className="text-xs text-ink-muted">
                          {event.metadata && Object.keys(event.metadata).length > 0
                            ? JSON.stringify(event.metadata)
                            : '—'}
                        </span>
                      )}
                    </Td>
                    <Td className="font-mono text-[10px] text-ink-muted">{event.ipAddress ?? '—'}</Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
