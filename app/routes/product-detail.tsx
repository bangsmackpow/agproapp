import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
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
} from '../components/ui';
import { ProductForm } from '../components/product-form';
import { parseProductForm } from '../lib/product-payload.server';
import { actionFailure, api, apiClient, getEnv, requireUser } from '../lib/api.server';
import { can } from '../../src/shared/rbac';
import { formatCents, formatDate } from '../lib/utils';
import { applyMultiplier, formatUsd } from '../../src/shared/pricing';

export const meta = () => [{ title: 'Product · AG Pro Solutions' }];

/** A "correction" larger than this is a data-entry error, not a physical count. */
const ADJUSTMENT_FLOOR = -10_000;

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);
  const client = apiClient(env, request);

  const [productResponse, vendorsResponse, tiersResponse] = await Promise.all([
    client.api.products[':id'].$get({ param: { id: params.id ?? '' } }),
    client.api.vendors.$get(),
    client.api.settings['price-tiers'].$get(),
  ]);

  if (!productResponse.ok) {
    throw new Response('That product does not exist.', { status: 404 });
  }

  const detail = await productResponse.json();
  const vendors = (await vendorsResponse.json()).data ?? [];
  const tiers = (await tiersResponse.json()).data ?? [];

  return {
    user,
    product: detail.product,
    ledger: detail.ledger ?? [],
    usedOnAcres: detail.usedOnAcres ?? 0,
    vendors: vendors.map((vendor) => ({ id: vendor.id, name: vendor.name })),
    tiers,
    canEditCatalog: can(user.role, 'manageCatalog'),
    canMoveStock: can(user.role, 'manageStock'),
  };
}

export async function action({ request, context, params }: ActionFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);
  const id = params.id ?? '';
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');

  const post = (path: string, body: unknown) =>
    api(env, request, path, { method: 'POST', body: JSON.stringify(body) });

  try {
    if (intent === 'edit') {
      if (!can(user.role, 'manageCatalog')) return { error: 'Your role may not change the catalog.' };

      const { payload, error } = parseProductForm(form, 'edit');
      if (error) return { error };

      await api(env, request, `/products/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      return redirect(`/inventory/${id}`);
    }

    if (intent === 'receive') {
      if (!can(user.role, 'manageStock')) return { error: 'Your role may not receive stock.' };

      const quantity = Number(form.get('quantity'));
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return { error: 'Enter how many units arrived, greater than zero.' };
      }

      const unitCost = String(form.get('unitCost') ?? '').trim();
      const vendorId = String(form.get('vendorId') ?? '').trim();
      const reference = String(form.get('reference') ?? '').trim();
      const note = String(form.get('note') ?? '').trim();

      await post(`/products/${id}/receipts`, {
        quantity,
        unit: String(form.get('unit') ?? '') || undefined,
        ...(unitCost ? { unitCostCents: Math.round(Number(unitCost) * 100) } : {}),
        ...(vendorId ? { vendorId } : {}),
        ...(reference ? { reference } : {}),
        ...(note ? { note } : {}),
      });
      return redirect(`/inventory/${id}`);
    }

    if (intent === 'adjust') {
      if (!can(user.role, 'manageStock')) return { error: 'Your role may not adjust stock.' };

      const delta = Number(form.get('delta'));
      const reason = String(form.get('reason') ?? '').trim();

      if (!Number.isFinite(delta) || delta === 0) {
        return { error: 'Enter the counted difference — positive for more, negative for less.' };
      }
      if (delta < ADJUSTMENT_FLOOR) {
        return { error: 'That correction is too large to be a physical count. Check the figure.' };
      }
      if (reason.length < 3) {
        return {
          error:
            'A reason is required. An unexplained change to the quantity of a chemical is the first thing an audit asks about.',
        };
      }

      await post(`/products/${id}/adjustments`, {
        delta,
        reason,
        unit: String(form.get('unit') ?? '') || undefined,
      });
      return redirect(`/inventory/${id}`);
    }

    return { error: 'Unknown action.' };
  } catch (caught) {
    // ApiError carries the server's message, so a refusal like "that would leave
    // the pool negative" reaches the form instead of a generic failure.
    return actionFailure(caught, 'The change was not recorded.');
  }
}

export default function ProductDetailRoute() {
  const {
    product,
    ledger,
    usedOnAcres,
    vendors,
    tiers,
    canEditCatalog,
    canMoveStock,
  } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();

  return (
    <>
      <PageHeader
        title={product.name}
        description={`${product.sku} · ${product.type} · on hand ${product.quantityOnHand} ${product.unit}`}
        actions={
          <div className="flex items-center gap-3">
            {product.needsReorder ? <Status tone="danger">Needs ordering</Status> : null}
            {!product.isInvoiceable ? <Badge tone="warning">No cost</Badge> : null}
            {!product.isActive ? <Badge tone="neutral">Inactive</Badge> : null}
            {product.isRegulatedSeed ? <Badge tone="info">Regulated seed</Badge> : null}
            <Link className="text-sm text-accent-text underline" to="/inventory">
              All inventory
            </Link>
          </div>
        }
      />

      {result?.error ? (
        <div className="mb-3">
          <Alert title={result.error} />
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <div className="rounded-md border border-border">
            <CardHeader
              title="Stock ledger"
              description="Every movement that produced the number above"
            />
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Type</Th>
                  <Th className="text-right">Change</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody>
                {ledger.length === 0 ? (
                  <EmptyRow colSpan={4} message="Nothing has moved yet — receive the first delivery below." />
                ) : (
                  ledger.map((movement) => (
                    <tr key={movement.id}>
                      <Td className="whitespace-nowrap text-ink-muted">
                        {formatDate(movement.occurredAt)}
                      </Td>
                      <Td className="capitalize">{movement.movementType}</Td>
                      <Td className="tabular text-right">
                        {movement.quantityDelta > 0 ? '+' : ''}
                        {movement.quantityDelta} {movement.unit ?? ''}
                      </Td>
                      <Td className="text-ink-muted">
                        {movement.note ?? '—'}
                        {movement.unitCostCents !== null ? (
                          <span className="ml-1 text-xs">
                            @ {formatCents(movement.unitCostCents)}
                          </span>
                        ) : null}
                      </Td>
                    </tr>
                  ))
                )}
              </tbody>
            </Table>
            <p className="border-t border-border px-3 py-1.5 text-xs text-ink-muted">
              {usedOnAcres} {product.unit} drawn by issued invoices. The ledger is append-only, so a
              correction is a new movement rather than an edit.
            </p>
          </div>

          {canEditCatalog ? (
            <Form method="post" className="rounded-md border border-border">
              <input type="hidden" name="intent" value="edit" />
              <CardHeader title="Edit product" description="Changing the cost reprices every new line" />
              <div className="px-3 py-3">
                <ProductForm
                  vendors={vendors}
                  product={{
                    sku: product.sku,
                    name: product.name,
                    description: product.description,
                    type: product.type,
                    unit: product.unit,
                    costCents: product.costCents,
                    epaNumber: product.epaNumber,
                    isRegulatedSeed: product.isRegulatedSeed,
                    reorderPoint: product.reorderPoint,
                    reorderQuantity: product.reorderQuantity,
                    vendorId: product.vendorId,
                    notes: product.notes,
                    isActive: product.isActive,
                  }}
                />
              </div>
              <div className="border-t border-border px-3 py-2">
                <Button type="submit" disabled={navigation.state === 'submitting'}>
                  {navigation.state === 'submitting' ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </Form>
          ) : null}
        </div>

        <div className="min-w-0 space-y-4">
          <div className="rounded-md border border-border">
            <CardHeader title="Price at each tier" description="cost × multiplier, computed not stored" />
            <dl className="divide-y divide-border text-sm">
              {product.costCents === null ? (
                <div className="px-3 py-2 text-ink-muted">
                  No cost on file, so this product cannot be invoiced. Enter one above.
                </div>
              ) : (
                tiers
                  .filter((tier) => tier.isActive)
                  .map((tier) => (
                    <div key={tier.id} className="flex items-center justify-between px-3 py-1.5">
                      <dt className="text-ink-muted">{tier.label}</dt>
                      <dd className="tabular">
                        {formatUsd(applyMultiplier(product.costCents ?? 0, tier.multiplier))}
                        <span className="ml-1 text-xs text-ink-muted">/ {product.unit}</span>
                      </dd>
                    </div>
                  ))
              )}
            </dl>
          </div>

          {canMoveStock ? (
            <Form method="post" className="rounded-md border border-border">
              <input type="hidden" name="intent" value="receive" />
              <CardHeader title="Receive stock" description="Arrived from a delivery" />
              <div className="grid gap-3 px-3 py-3">
                <Field label="Quantity">
                  <Input name="quantity" type="number" step="0.01" min="0" required />
                </Field>
                <Field label="Unit" hint="Defaults to the product unit">
                  <Select name="unit" defaultValue={product.unit}>
                    <option value="">Product unit</option>
                    {['gal', 'qt', 'pt', 'oz', 'lb', 'ton', 'bag', 'jug', 'bottle', 'each'].map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Unit cost" hint="Dollars. Updates what new lines price from.">
                  <Input
                    name="unitCost"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={product.costCents !== null ? (product.costCents / 100).toFixed(2) : ''}
                  />
                </Field>
                <Field label="Vendor">
                  <Select name="vendorId" defaultValue={product.vendorId ?? ''}>
                    <option value="">—</option>
                    {vendors.map((vendor) => (
                      <option key={vendor.id} value={vendor.id}>
                        {vendor.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reference" hint="Invoice or BOL number this arrived against">
                  <Input name="reference" maxLength={120} />
                </Field>
                <Button type="submit" disabled={navigation.state === 'submitting'}>
                  {navigation.state === 'submitting' ? 'Recording…' : 'Record receipt'}
                </Button>
              </div>
            </Form>
          ) : null}

          {canMoveStock ? (
            <Form method="post" className="rounded-md border border-border">
              <input type="hidden" name="intent" value="adjust" />
              <CardHeader title="Adjust count" description="A physical count disagreed with the books" />
              <div className="grid gap-3 px-3 py-3">
                <Field label="Difference" hint="Positive for more found, negative for less">
                  <Input name="delta" type="number" step="0.01" required />
                </Field>
                <Field label="Reason" hint="Required, and it is kept">
                  <Input name="reason" maxLength={500} required placeholder="Spill during transfer" />
                </Field>
                <Button type="submit" variant="secondary" disabled={navigation.state === 'submitting'}>
                  {navigation.state === 'submitting' ? 'Recording…' : 'Record adjustment'}
                </Button>
              </div>
            </Form>
          ) : null}

          <div className="rounded-md border border-border">
            <CardHeader title="Facts" />
            <dl className="divide-y divide-border text-sm">
              <Row label="Division" value={product.type} />
              <Row label="Unit" value={product.unit} />
              <Row label="Cost" value={product.costCents === null ? 'none' : formatCents(product.costCents)} />
              <Row label="EPA number" value={product.epaNumber ?? '—'} />
              <Row label="Reorder point" value={product.reorderPoint === null ? 'alerting off' : String(product.reorderPoint)} />
              <Row label="Suggested quantity" value={product.reorderQuantity === null ? '—' : String(product.reorderQuantity)} />
              <Row label="Vendor" value={product.vendorName ?? '—'} />
              <Row label="Created" value={formatDate(product.createdAt)} />
            </dl>
            {product.description || product.notes ? (
              <div className="space-y-2 border-t border-border px-3 py-2 text-sm">
                {product.description ? <p className="text-ink-muted">{product.description}</p> : null}
                {product.notes ? <p className="text-ink-muted">{product.notes}</p> : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="capitalize">{value}</dd>
    </div>
  );
}
