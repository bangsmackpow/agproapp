import { isbot } from 'isbot';
import type { ReactNode } from 'react';
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from 'react-router';

import './app.css';

export const meta = () => [
  { title: 'AG Pro Solutions' },
  { name: 'robots', content: 'noindex, nofollow' },
];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold text-ink">
          {error.status} {error.statusText}
        </h1>
        <p className="mt-2 text-ink-muted">
          {typeof error.data === 'string' ? error.data : 'That request could not be completed.'}
        </p>
        <a className="mt-6 inline-block text-brand-700 underline" href="/">
          Back to the dashboard
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold text-ink">Something went wrong</h1>
      <p className="mt-2 text-ink-muted">
        {isbot(navigator?.userAgent ?? '')
          ? 'An unexpected error occurred.'
          : (error as Error)?.message ?? 'An unexpected error occurred.'}
      </p>
      <a className="mt-6 inline-block text-brand-700 underline" href="/">
        Back to the dashboard
      </a>
    </main>
  );
}
