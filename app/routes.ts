import type { RouteConfig } from '@react-router/dev/routes';
import { index, layout, route } from '@react-router/dev/routes';

/**
 * Route table (v2).
 *
 * The `shell` layout performs the session check for every child, so an
 * unauthenticated request can never reach a screen loader.
 *
 * Print routes (`/invoices/:id/print`) deliberately live outside the layout: no
 * navigation or app chrome may reach paper. They join with the invoicing phase.
 */
export default [
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.tsx'),
  layout('routes/shell.tsx', [
    index('routes/dashboard.tsx'),
    route('inventory', 'routes/inventory.tsx'),
    // Declared before `inventory/:id`, or the literal path is read as a record id
    // and never reaches the create screen.
    route('inventory/new', 'routes/inventory-new.tsx'),
    route('inventory/:id', 'routes/product-detail.tsx'),
    route('vendors', 'routes/vendors.tsx'),
    // Programs, customers, invoices, seed records, settings, users, and activity
    // join in their own phases.
  ]),
] satisfies RouteConfig;
