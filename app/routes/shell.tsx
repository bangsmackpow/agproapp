import { Form, NavLink, Outlet } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';

import { Badge, Button } from '../components/ui';
import { ThemeToggle } from '../components/theme';
import { getEnv, requireUser, type SessionUser } from '../lib/api.server';
import { can, ROLE_LABELS, type Capability } from '../../src/shared/rbac';
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
  /** Omitted means: every signed-in role may see it. */
  capability?: Capability;
  /** True for the layout index, which would otherwise match every path. */
  end?: boolean;
}

/**
 * The nav is driven off the same capability map the API enforces, so a link never
 * points at a screen the user cannot use. Entries are added with their phase.
 */
const NAV: NavItem[] = [{ to: '/', label: 'Dashboard', end: true }];

export default function ShellRoute({ loaderData }: { loaderData: { user: SessionUser } }) {
  const { user } = loaderData;
  const items = NAV.filter((item) => !item.capability || can(user.role, item.capability));

  return (
    <div className="min-h-dvh lg:flex">
      {/* Keyboard users should not have to tab the whole nav on every page. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:border focus:border-border focus:bg-surface focus:px-3 focus:py-1.5 focus:text-sm focus:text-ink"
      >
        Skip to content
      </a>

      <aside className="border-b border-border bg-surface lg:w-56 lg:shrink-0 lg:border-r lg:border-b-0">
        <div className="flex items-center gap-3 px-4 py-3 lg:block">
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

        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:overflow-visible lg:px-2 lg:pb-4">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              data-tap
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap',
                  isActive
                    ? 'bg-accent-muted font-semibold text-accent-text'
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

          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Form method="post" action="/logout">
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </Form>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
