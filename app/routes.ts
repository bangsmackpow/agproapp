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
    // Catalog, customers, programs, invoices, seed records, vendors, settings,
    // users, and activity join in their own phases.
  ]),
] satisfies RouteConfig;
