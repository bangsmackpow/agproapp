import type { UserRole } from './enums';

/**
 * Access control: three roles, one capability map.
 *
 * The first build carried a 19-permission matrix built for a larger organization
 * than a handful of people in one office. Three capabilities differences actually
 * exist here, so v2 names the abilities themselves. Middleware and the UI read the
 * same map, so a hidden button and a rejected request can never disagree.
 *
 * Deny-by-default: a capability not listed for a role is forbidden.
 */
export const CAPABILITIES = [
  /** Customers: create, edit, deactivate. */
  'manageCustomers',
  /** Catalog: create and edit products, programs, and their costs. */
  'manageCatalog',
  /** Receive stock and record count adjustments. */
  'manageStock',
  /** Create and edit draft invoices. */
  'manageInvoices',
  /** Run the issue gate — a draft becomes an immutable issued invoice. */
  'issueInvoices',
  /** Void an issued invoice, reversing its stock. */
  'voidInvoices',
  /** Record payments against an issued invoice. */
  'recordPayments',
  /** Maintain the Iowa seed compliance records. */
  'manageCompliance',
  /** Read the activity log. */
  'viewActivity',
  /** Edit company settings: letterhead, tax rate, tiers, service rates. */
  'manageSettings',
  /** Create, deactivate, and reset users. */
  'manageUsers',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const STAFF: readonly Capability[] = [
  'manageCustomers',
  'manageStock',
  'manageInvoices',
  'issueInvoices',
  'recordPayments',
];

/** Managers add catalog control and the ability to undo — void and audit-read. */
const MANAGER: readonly Capability[] = [
  ...STAFF,
  'manageCatalog',
  'voidInvoices',
  'manageCompliance',
  'viewActivity',
];

const ADMIN: readonly Capability[] = [...MANAGER, 'manageSettings', 'manageUsers'];

export const ROLE_CAPABILITIES: Record<UserRole, readonly Capability[]> = {
  staff: STAFF,
  manager: MANAGER,
  admin: ADMIN,
};

export function can(role: UserRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

/** Throws when the role lacks the capability. Used by API middleware. */
export function assertCan(role: UserRole, capability: Capability): void {
  if (!can(role, capability)) {
    throw new Error(`FORBIDDEN: role "${role}" lacks capability "${capability}"`);
  }
}

export const ROLE_LABELS: Record<UserRole, string> = {
  staff: 'Staff',
  manager: 'Manager',
  admin: 'Administrator',
};
