import { Form, NavLink, Outlet } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';

import { Badge, Button } from '../components/ui';
import { getEnv, requireUser, type SessionUser } from '../lib/api.server';
import { ROLE_LABELS, can, canAccessCheckwriting } from '../../src/shared/rbac';
import { cn } from '../lib/utils';

export const meta = () => [{ title: 'AG Pro Solutions' }];

/** The session gate for every authenticated screen. */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await requireUser(env, request);
  return { user };
}

interface NavItem {
  to: string;
  label: string;
  show: boolean;
}

function navItems(user: SessionUser): NavItem[] {
  return [
    { to: '/', label: 'Dashboard', show: true },
    { to: '/customers', label: 'Customers', show: can(user.role, 'crm:read') },
    { to: '/inventory', label: 'Inventory', show: can(user.role, 'inventory:read') },
    { to: '/invoices', label: 'Invoices', show: can(user.role, 'invoices:read') },
    { to: '/imports', label: 'Imports', show: can(user.role, 'inventory:import') },
    { to: '/checks', label: 'Checkwriting', show: canAccessCheckwriting(user.role) },
    { to: '/audit', label: 'Audit', show: can(user.role, 'admin:audit') },
  ];
}

export default function ShellRoute({ loaderData }: { loaderData: { user: SessionUser } }) {
  const { user } = loaderData;
  const items = navItems(user).filter((item) => item.show);

  return (
    <div className="min-h-screen lg:flex">
      <aside className="border-b border-border bg-surface lg:w-60 lg:shrink-0 lg:border-r lg:border-b-0">
        <div className="flex items-center justify-between gap-3 px-4 py-3 lg:block">
          <div className="flex items-center gap-3 lg:block">
            <img
              src="/logo.jpg"
              alt=""
              width={40}
              height={40}
              className="h-10 w-10 rounded object-contain lg:mb-2"
            />
            <div>
              <p className="text-sm font-semibold text-ink">AG Pro Solutions</p>
              <p className="text-xs text-ink-muted">Creston, Iowa</p>
            </div>
          </div>
        </div>

        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:overflow-visible lg:px-2 lg:pb-4">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              data-tap
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap',
                  isActive
                    ? 'bg-brand-50 text-brand-900'
                    : 'text-ink-muted hover:bg-muted hover:text-ink',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-ink">{user.name}</span>
            <Badge tone={user.role === 'admin' ? 'info' : 'neutral'}>
              {ROLE_LABELS[user.role]}
            </Badge>
          </div>

          <Form method="post" action="/logout">
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </Form>
        </header>

        <main className="min-w-0 flex-1 p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
