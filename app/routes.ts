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
  route('logout', 'routes/logout.tsx'),
  // Outside the shell layout: nothing that would land on paper.
  route('invoices/:id/print', 'routes/invoice-print.tsx'),
  route('checks/:id/print', 'routes/check-print.tsx'),
  layout('routes/shell.tsx', [
    index('routes/dashboard.tsx'),
    route('customers', 'routes/customers.tsx'),
    route('customers/new', 'routes/customer-new.tsx'),
    route('customers/:id', 'routes/customer-detail.tsx'),
    route('inventory', 'routes/inventory.tsx'),
    // Declared before `inventory/:id`, or the literal path would be read as a
    // record id and never reach the create screen.
    route('inventory/new', 'routes/inventory-new.tsx'),
    route('inventory/:id', 'routes/product-detail.tsx'),
    route('invoices', 'routes/invoices.tsx'),
    route('invoices/new', 'routes/invoice-new.tsx'),
    route('invoices/:id', 'routes/invoice-detail.tsx'),
    route('checks', 'routes/checks.tsx'),
    route('imports', 'routes/imports.tsx'),
    route('audit', 'routes/audit.tsx'),
  ]),
] satisfies RouteConfig;
