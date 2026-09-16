import { redirect } from 'react-router';
import type { ActionFunctionArgs } from 'react-router';

import { extractSetCookie, getEnv, rawApi } from '../lib/api.server';

/**
 * Sign out.
 *
 * Deliberately its own top-level route rather than an action on the shell layout.
 * React Router resolves an action from the routes matched by the submission path,
 * and a pathless layout's action is not used for a submission to one of its
 * children — so a sign-out form in the layout chrome could never reach it.
 */

/** A stray GET lands back on the dashboard rather than 404ing. */
export function loader() {
  throw redirect('/');
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);

  // Revoke server-side, then clear the cookie regardless: if the session was
  // already invalid there is nothing left to revoke, but the browser should still
  // end up signed out rather than holding a dead cookie.
  const response = await rawApi(env, request, '/auth/logout', { method: 'POST' });
  const cleared = extractSetCookie(response);

  throw redirect('/login', cleared ? { headers: { 'Set-Cookie': cleared } } : undefined);
}
