/**
 * Builds a customer payload from the shared form.
 *
 * Empty text fields become `undefined` rather than `""`, so they are omitted from
 * the JSON and left untouched by a PATCH. The API's optional text fields accept a
 * string or nothing, not null, so omitting is also the only way to say "unchanged"
 * — which does mean a field cannot currently be blanked once set. Flagged rather
 * than worked around, because supporting it needs an API change.
 */
export function parseCustomerForm(form: FormData) {
  const text = (key: string): string | undefined => {
    const raw = String(form.get(key) ?? '').trim();
    return raw === '' ? undefined : raw;
  };

  const count = (key: string): number | undefined => {
    const raw = String(form.get(key) ?? '').trim();
    if (raw === '') return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const flag = (key: string): boolean => String(form.get(key) ?? '') === 'true';

  return {
    name: String(form.get('name') ?? '').trim(),
    contactName: text('contactName'),
    phone: text('phone'),
    email: text('email'),

    billLine1: text('billLine1'),
    billLine2: text('billLine2'),
    billCity: text('billCity'),
    billState: text('billState'),
    billPostalCode: text('billPostalCode'),

    shipLine1: text('shipLine1'),
    shipLine2: text('shipLine2'),
    shipCity: text('shipCity'),
    shipState: text('shipState'),
    shipPostalCode: text('shipPostalCode'),

    pesticideLicenseNumber: text('pesticideLicenseNumber'),
    resaleCertificateNumber: text('resaleCertificateNumber'),
    defaultTermsDays: count('defaultTermsDays'),
    notes: text('notes'),

    taxExempt: flag('taxExempt'),
    isActive: flag('isActive'),
  };
}
