import type { UserRole } from './enums';

/**
 * Role-Based Access Control.
 *
 * Deny-by-default: a permission that is not explicitly granted to a role is
 * forbidden. Phase 2 middleware calls `assertCan(role, permission)`; the UI
 * (Phase 3) uses `can()` to hide affordances. Both read this single matrix so
 * they can never drift apart.
 */

export const PERMISSIONS = [
  // CRM
  'crm:read',
  'crm:write',
  'crm:delete',

  // Inventory
  'inventory:read',
  'inventory:write',
  'inventory:import',

  // Pricing engine
  'pricing:read',
  'pricing:write',
  'pricing:tiers',

  // Invoicing
  'invoices:read',
  'invoices:write',
  'invoices:send',
  'invoices:cancel',

  // Reporting
  'reports:read',

  // Checkwriting (Admin-exclusive)
  'checks:read',
  'checks:write',
  'checks:print',
  'checks:void',

  // System administration
  'admin:users',
  'admin:settings',
  'admin:audit',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const SALES_PERMISSIONS = [
  'crm:read',
  'crm:write',
  'inventory:read',
  'pricing:read',
  'invoices:read',
  'invoices:write',
  'invoices:send',
] as const satisfies readonly Permission[];

const MANAGER_PERMISSIONS = [
  ...SALES_PERMISSIONS,
  'crm:delete',
  'inventory:write',
  'inventory:import',
  'pricing:write',
  'invoices:cancel',
  'reports:read',
] as const satisfies readonly Permission[];

const ADMIN_PERMISSIONS = PERMISSIONS;

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  sales: SALES_PERMISSIONS,
  manager: MANAGER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
};

export function can(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Throws when the role lacks the permission. Used by API middleware. */
export function assertCan(role: UserRole, permission: Permission): void {
  if (!can(role, permission)) {
    throw new Error(`FORBIDDEN: role "${role}" lacks permission "${permission}"`);
  }
}

/** Routes that only an Admin may reach at all (hard lockdown). */
export const ADMIN_ONLY_ROUTE_PREFIXES = ['/checks', '/api/checks', '/api/admin'] as const;

/** True when the role may see the checkwriting module. */
export function canAccessCheckwriting(role: UserRole): boolean {
  return can(role, 'checks:read');
}

/** Human-readable label for a role, for UI chrome. */
export const ROLE_LABELS: Record<UserRole, string> = {
  sales: 'Sales',
  manager: 'Manager',
  admin: 'Administrator',
};
