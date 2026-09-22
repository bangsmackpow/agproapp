import { Link, useLoaderData } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';

import {
  Alert,
  CardHeader,
  EmptyRow,
  PageHeader,
  Stat,
  Status,
  Table,
  Td,
  Th,
} from '../components/ui';
import { apiClient, getEnv, requireUser } from '../lib/api.server';
import { formatCents, formatPercent } from '../lib/utils';

export const meta = () => [{ title: 'Dashboard · AG Pro Solutions' }];

/**
 * The one screen every role needs on arrival: is this business configured enough
 * to invoice anything?
 *
 * The three things that gate a first invoice are a letterhead, at least one price
 * tier, and a service rate for application and mileage. Each is read live, so an
 * unseeded database says so plainly instead of failing later inside a form.
 *
 * Response shapes are inferred from the API by the typed client — there is no
 * hand-written interface here, which is exactly what drifted in the first build.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);
  const client = apiClient(env, request);

  const [settingsResponse, tiersResponse, ratesResponse, attentionResponse, productsResponse] =
    await Promise.all([
      client.api.settings.$get(),
      client.api.settings['price-tiers'].$get(),
      client.api.settings['service-rates'].$get(),
      client.api.inventory.attention.$get(),
      // Only the total is needed; the page size keeps the payload to one row.
      client.api.products.$get({ query: { limit: '1' } }),
    ]);

  const settings = (await settingsResponse.json()).data;
  const tiers = (await tiersResponse.json()).data;
  const rates = (await ratesResponse.json()).data;
  const attention = (await attentionResponse.json()).data ?? { low: [], missingCost: 0 };
  const productsPage = await productsResponse.json();

  return {
    user,
    settings,
    tiers,
    rates,
    low: attention.low,
    missingCost: attention.missingCost,
    productCount: productsPage.pagination?.total ?? 0,
  };
}

export default function DashboardRoute() {
  const { user, settings, tiers, rates, low, missingCost, productCount } =
    useLoaderData<typeof loader>();

  const activeTiers = tiers.filter((tier) => tier.isActive);
  const activeRates = rates.filter((rate) => rate.isActive);
  const blocked: string[] = [];
  if (activeTiers.length === 0) blocked.push('no active price tier, so nothing can be priced');
  if (activeRates.length === 0) blocked.push('no service rate, so application and mileage have nothing to bill from');
  // The wall the first build hit: a product with no cost exists but cannot be
  // sold, and finding that out at the composer is the worst time to learn it.
  if (missingCost > 0) {
    blocked.push(
      `${missingCost} product${missingCost === 1 ? '' : 's'} have no cost and cannot be invoiced yet`,
    );
  }

  return (
    <>
      <PageHeader
        title={`Good to see you, ${user.name.split(' ')[0]}`}
        description="Where the season stands."
      />

      {blocked.length > 0 ? (
        <div className="mb-3">
          <Alert title="Not ready to invoice yet.">
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {blocked.map((reason) => (
                <li key={reason}>{reason[0]!.toUpperCase() + reason.slice(1)}.</li>
              ))}
            </ul>
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Needs ordering"
          value={String(low.length)}
          hint={low.length > 0 ? 'At or below the reorder point' : 'Nothing flagged'}
        />
        <Stat label="Catalogued" value={String(productCount)} hint="Products in the catalog" />
        <Stat
          label="Not invoiceable"
          value={String(missingCost)}
          hint="No cost entered yet"
        />
        <Stat
          label="Tax rate"
          value={formatPercent(settings.defaultTaxRate)}
          hint={`${settings.defaultTermsDays}-day terms by default`}
        />
      </div>

      {/* The question this screen exists to answer without a click. */}
      <div className="mt-4 rounded-md border border-border">
        <CardHeader
          title="Needs ordering"
          description="On hand is summed from the stock ledger, not stored"
          actions={
            low.length > 0 ? (
              <Link className="text-sm text-accent-text underline" to="/inventory?stock=low">
                Open the list
              </Link>
            ) : null
          }
        />
        <Table>
          <thead>
            <tr>
              <Th>Item</Th>
              <Th className="text-right">On hand</Th>
              <Th className="text-right">Reorder point</Th>
              <Th className="text-right">Suggested</Th>
              <Th>Order from</Th>
            </tr>
          </thead>
          <tbody>
            {low.length === 0 ? (
              <EmptyRow colSpan={5} message="Nothing is at or below its reorder point." />
            ) : (
              low.map((item) => (
                <tr key={item.id} className="hover:bg-muted/40">
                  <Td>
                    <Link
                      to={`/inventory/${item.id}`}
                      className="font-medium text-accent-text hover:underline"
                    >
                      {item.name}
                    </Link>
                    <span className="ml-2 text-xs text-ink-muted">{item.sku}</span>
                  </Td>
                  <Td className="tabular text-right">
                    <Status tone="danger">{`${item.quantityOnHand} ${item.unit}`}</Status>
                  </Td>
                  <Td className="tabular text-right">{item.reorderPoint ?? '—'}</Td>
                  <Td className="tabular text-right">{item.reorderQuantity ?? '—'}</Td>
                  <Td className="text-ink-muted">{item.vendorName ?? 'No vendor on file'}</Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <div className="min-w-0 rounded-md border border-border">
          <CardHeader
            title="Price tiers"
            description="Price is always cost x the selected tier's multiplier"
          />
          <Table>
            <thead>
              <tr>
                <Th>Tier</Th>
                <Th className="text-right">Multiplier</Th>
                <Th>Needs license</Th>
              </tr>
            </thead>
            <tbody>
              {activeTiers.length === 0 ? (
                <EmptyRow colSpan={3} message="No tiers seeded. Run the reference seed." />
              ) : (
                activeTiers.map((tier) => (
                  <tr key={tier.id}>
                    <Td>
                      {tier.label}
                      <span className="ml-2 text-xs text-ink-muted">{tier.key}</span>
                    </Td>
                    <Td className="tabular text-right">{tier.multiplier.toFixed(2)}×</Td>
                    <Td>{tier.requiresPesticideLicense ? 'Yes' : 'No'}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </div>

        <div className="min-w-0 rounded-md border border-border">
          <CardHeader
            title="Service rates"
            description="Application and mileage lines bill from these"
          />
          <Table>
            <thead>
              <tr>
                <Th>Rate</Th>
                <Th>Kind</Th>
                <Th className="text-right">Price</Th>
              </tr>
            </thead>
            <tbody>
              {activeRates.length === 0 ? (
                <EmptyRow colSpan={3} message="No service rates yet — add them in Settings." />
              ) : (
                activeRates.map((rate) => (
                  <tr key={rate.id}>
                    <Td>{rate.label}</Td>
                    <Td className="text-ink-muted capitalize">{rate.kind.replace('_', ' ')}</Td>
                    <Td className="tabular text-right">
                      {formatCents(rate.priceCents)} / {rate.unit}
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </div>
      </div>
    </>
  );
}
