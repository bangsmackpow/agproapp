import type { RouteConfig } from '@react-router/dev/routes';
import { index, layout, route } from '@react-router/dev/routes';

/**
 * Route table.
 *
 * The `shell` layout performs the session check for every child, so an
 * unauthenticated request can never reach a screen loader.
 */
export default [
  route('login', 'routes/login.tsx'),
  layout('routes/shell.tsx', [
    index('routes/dashboard.tsx'),
    route('customers', 'routes/customers.tsx'),
    route('inventory', 'routes/inventory.tsx'),
    route('invoices', 'routes/invoices.tsx'),
    route('invoices/:id', 'routes/invoice-detail.tsx'),
    route('checks', 'routes/checks.tsx'),
    route('imports', 'routes/imports.tsx'),
  ]),
] satisfies RouteConfig;
