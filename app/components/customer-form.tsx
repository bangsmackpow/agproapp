import { Form, useNavigation } from 'react-router';

import { Button, Field, Input, Select } from './ui';

/**
 * The customer field set, shared by the create and edit screens.
 *
 * Every optional field the CRM holds lives here rather than on the customer list,
 * so the list can stay a list. `intent` tells the two screens' actions apart.
 */
export interface CustomerDefaults {
  id?: string;
  accountNumber?: string | null;
  name?: string | null;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  billLine1?: string | null;
  billLine2?: string | null;
  billCity?: string | null;
  billState?: string | null;
  billPostalCode?: string | null;
  shipLine1?: string | null;
  shipLine2?: string | null;
  shipCity?: string | null;
  shipState?: string | null;
  shipPostalCode?: string | null;
  pesticideLicenseNumber?: string | null;
  resaleCertificateNumber?: string | null;
  defaultTermsDays?: number | null;
  notes?: string | null;
  taxExempt?: boolean;
  isActive?: boolean;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="border-t border-border px-3 py-3 first:border-t-0">
      <legend className="px-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
        {title}
      </legend>
      <div className="mt-1 grid gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

export function CustomerForm({
  customer,
  submitLabel,
}: {
  customer?: CustomerDefaults;
  submitLabel: string;
}) {
  const navigation = useNavigation();
  const submitting = navigation.state === 'submitting';
  const value = (field: keyof CustomerDefaults) => (customer?.[field] as string | null) ?? '';

  return (
    <Form method="post" className="space-y-0">
      <input type="hidden" name="intent" value={customer?.id ? 'update' : 'create'} />
      {customer?.id ? <input type="hidden" name="customerId" value={customer.id} /> : null}

      <Section title="Identity">
        <Field label="Account number">
          <Input name="accountNumber" required defaultValue={value('accountNumber')} placeholder="AGP-003" />
        </Field>
        <Field label="Name">
          <Input name="name" required defaultValue={value('name')} placeholder="Prairie Ridge Farms" />
        </Field>
        <Field label="Contact">
          <Input name="contactName" defaultValue={value('contactName')} placeholder="Optional" />
        </Field>
        <Field label="Phone">
          <Input name="phone" defaultValue={value('phone')} placeholder="641-555-0100" />
        </Field>
        <Field label="Email" hint="Used for invoice delivery">
          <Input name="email" type="email" defaultValue={value('email')} placeholder="Optional" />
        </Field>
        <Field label="Default terms (days)" hint="Falls back to the company default">
          <Input
            name="defaultTermsDays"
            type="number"
            min={0}
            max={365}
            defaultValue={customer?.defaultTermsDays ?? ''}
          />
        </Field>
      </Section>

      <Section title="Billing address">
        <Field label="Line 1">
          <Input name="billLine1" defaultValue={value('billLine1')} />
        </Field>
        <Field label="Line 2">
          <Input name="billLine2" defaultValue={value('billLine2')} />
        </Field>
        <Field label="City">
          <Input name="billCity" defaultValue={value('billCity')} placeholder="Creston" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="State">
            <Input name="billState" maxLength={2} defaultValue={value('billState')} placeholder="IA" />
          </Field>
          <Field label="ZIP">
            <Input name="billPostalCode" defaultValue={value('billPostalCode')} />
          </Field>
        </div>
      </Section>

      <Section title="Shipping address">
        <Field label="Line 1">
          <Input name="shipLine1" defaultValue={value('shipLine1')} />
        </Field>
        <Field label="Line 2">
          <Input name="shipLine2" defaultValue={value('shipLine2')} />
        </Field>
        <Field label="City">
          <Input name="shipCity" defaultValue={value('shipCity')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="State">
            <Input name="shipState" maxLength={2} defaultValue={value('shipState')} />
          </Field>
          <Field label="ZIP">
            <Input name="shipPostalCode" defaultValue={value('shipPostalCode')} />
          </Field>
        </div>
      </Section>

      <Section title="Licensing and tax">
        <Field
          label="Pesticide licence"
          hint="Required at time of sale for carry tiers"
        >
          <Input name="pesticideLicenseNumber" defaultValue={value('pesticideLicenseNumber')} />
        </Field>
        <Field label="Resale certificate">
          <Input name="resaleCertificateNumber" defaultValue={value('resaleCertificateNumber')} />
        </Field>
        <Field label="Tax exempt" hint="Suppresses sales tax on this account's invoices">
          <Select name="taxExempt" defaultValue={customer?.taxExempt ? 'true' : 'false'}>
            <option value="false">No</option>
            <option value="true">Yes</option>
          </Select>
        </Field>
        <Field label="Status">
          <Select name="isActive" defaultValue={customer?.isActive === false ? 'false' : 'true'}>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </Select>
        </Field>
      </Section>

      <Section title="Notes">
        <div className="sm:col-span-2">
          <Field label="Internal notes">
            <textarea
              name="notes"
              rows={3}
              defaultValue={value('notes')}
              className="w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm text-ink focus:border-brand-600 focus:outline-none"
            />
          </Field>
        </div>
      </Section>

      <div className="border-t border-border px-3 py-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </Form>
  );
}
