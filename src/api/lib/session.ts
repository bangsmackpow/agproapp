import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from './constants';

export { SESSION_COOKIE_NAME, SESSION_TTL_MS };

/** 32 bytes of CSPRNG output, base64url-encoded. Opaque to the client. */
export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * SHA-256 hex digest of a session token.
 *
 * Only the digest is ever persisted, so a leaked database snapshot cannot be
 * replayed as a valid session.
 */
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function sessionMaxAgeSeconds(): number {
  return Math.floor(SESSION_TTL_MS / 1000);
}

export function sessionExpiry(now = new Date()): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}
