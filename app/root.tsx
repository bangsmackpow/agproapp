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
import { THEME_SCRIPT } from './components/theme';

export const meta = () => [
  { title: 'AG Pro Solutions' },
  { name: 'robots', content: 'noindex, nofollow' },
];

// Declared so the browser fetches the icon we ship, instead of probing
// /favicon.ico and logging a routing error on every page load.
export const links = () => [{ rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Tinted browser chrome; the resolver below keeps it in step. */}
        <meta name="theme-color" content="#ffffff" />
        {/*
          Resolves the stored theme before the first paint so the page never
          flashes the wrong colours. Must run synchronously, hence inline.
          A future CSP will need a nonce/hash for this — see components/theme.tsx.
          It must run after the theme-color meta above so it can update it.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body className="min-h-dvh">
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
        <h1           className="text-2xl font-semibold text-balance text-ink">
          {error.status} {error.statusText}
        </h1>
        <p className="mt-2 text-ink-muted">
          {typeof error.data === 'string' ? error.data : 'That request could not be completed.'}
        </p>
        <a className="mt-6 inline-block text-accent-text underline" href="/">
          Back to the dashboard
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1           className="text-2xl font-semibold text-balance text-ink">Something went wrong</h1>
      <p className="mt-2 text-ink-muted">
        {isbot(navigator?.userAgent ?? '')
          ? 'An unexpected error occurred.'
          : (error as Error)?.message ?? 'An unexpected error occurred.'}
      </p>
      <a className="mt-6 inline-block text-accent-text underline" href="/">
        Back to the dashboard
      </a>
    </main>
  );
}
