import { useState } from 'react';
import { Form, redirect, useActionData, useNavigation } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

import { Alert, Button, Field, Input } from '../components/ui';
import { ThemeToggle } from '../components/theme';
import { extractSetCookie, getEnv, getSessionUser, rawApi } from '../lib/api.server';

export const meta = () => [{ title: 'Sign in · AG Pro Solutions' }];

/**
 * Resolves the post-login destination, refusing anything off-origin.
 *
 * `startsWith('/')` is not sufficient on its own: `//evil.com` starts with a slash
 * but browsers read it as protocol-relative, so it would send someone straight to
 * an attacker's site immediately after they authenticated — a credible phishing
 * pivot. Requiring a single leading slash (not two) keeps the target a real path
 * on this origin.
 */
function safeNext(next: string | null): string {
  return next && /^\/(?!\/)/.test(next) ? next : '/';
}

/** Anyone already signed in has no business on the login screen. */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const user = await getSessionUser(env, request);

  if (user) {
    throw redirect(safeNext(new URL(request.url).searchParams.get('next')));
  }

  return null;
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const form = await request.formData();

  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');

  if (!email || !password) {
    return { error: 'Enter your email address and password.' };
  }

  const response = await rawApi(env, request, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    return { error: payload?.error?.message ?? 'Sign in failed.' };
  }

  const setCookie = extractSetCookie(response);
  if (!setCookie) {
    return { error: 'The server did not issue a session. Please try again.' };
  }

  const next = new URL(request.url).searchParams.get('next');

  // Re-emit the API's own Set-Cookie on the redirect so the browser stores it.
  throw redirect(safeNext(next), { headers: { 'Set-Cookie': setCookie } });
}

export default function LoginRoute() {
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const [showPassword, setShowPassword] = useState(false);

  return (
    <main className="relative flex min-h-dvh items-center justify-center bg-muted px-4 py-10">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <img
            src="/logo.jpg"
            alt="AG Pro Solutions"
            width={132}
            height={132}
            className="mx-auto h-[132px] w-[132px] rounded-lg object-contain"
          />
          <p className="mt-3 text-sm text-ink-muted">Putting The Farmer Back In Control</p>
        </div>

        <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
          {result?.error ? (
            <div className="mb-4">
              <Alert title={result.error} />
            </div>
          ) : null}

          <Form method="post" className="space-y-4">
            <Field label="Email">
              <Input
                name="email"
                type="email"
                autoComplete="username"
                required
                autoFocus
                placeholder="you@agpro.com"
              />
            </Field>

            <Field label="Password">
              <div className="flex gap-2">
                <Input
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </Button>
              </div>
            </Field>

            <Button type="submit" className="w-full" disabled={navigation.state === 'submitting'}>
              {navigation.state === 'submitting' ? 'Signing in…' : 'Sign in'}
            </Button>
          </Form>
        </div>
      </div>
    </main>
  );
}
