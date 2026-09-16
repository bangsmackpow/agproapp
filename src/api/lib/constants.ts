/**
 * Shared auth constants.
 *
 * Kept dependency-free so both the session helpers and the middleware can import
 * them without pulling in a framework.
 */

export const SESSION_COOKIE_NAME = 'agpro_session';

/** 12 hours: long enough for a full field day, short enough to bound exposure. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Minimum password length enforced at the API boundary. */
export const MIN_PASSWORD_LENGTH = 12;
