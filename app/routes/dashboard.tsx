import { useLoaderData } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';

import {
  Alert,
  CardHeader,
  EmptyRow,
  PageHeader,
  Stat,
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

  const [settingsResponse, tiersResponse, ratesResponse] = await Promise.all([
    client.api.settings.$get(),
    client.api.settings['price-tiers'].$get(),
    client.api.settings['service-rates'].$get(),
  ]);

  const settings = (await settingsResponse.json()).data;
  const tiers = (await tiersResponse.json()).data;
  const rates = (await ratesResponse.json()).data;

  return { user, settings, tiers, rates };
}

export default function DashboardRoute() {
  const { user, settings, tiers, rates } = useLoaderData<typeof loader>();

  const activeTiers = tiers.filter((tier) => tier.isActive);
  const activeRates = rates.filter((rate) => rate.isActive);
  const blocked: string[] = [];
  if (activeTiers.length === 0) blocked.push('no active price tier, so nothing can be priced');
  if (activeRates.length === 0) blocked.push('no service rate, so application and mileage have nothing to bill from');

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
        <Stat label="Company" value={settings.displayName} hint={settings.legalName} />
        <Stat
          label="Tax rate"
          value={formatPercent(settings.defaultTaxRate)}
          hint="Applied to every new invoice"
        />
        <Stat label="Terms" value={`${settings.defaultTermsDays} days`} hint="Default when unpaid" />
        <Stat label="Active tiers" value={String(activeTiers.length)} hint="Margin multipliers" />
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
