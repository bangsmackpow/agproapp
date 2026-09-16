import { createApp } from './api/app';

/**
 * Worker entry point.
 *
 * The Hono application implements the `ExportedHandler` surface directly, so the
 * Worker is a thin adapter with no routing logic of its own.
 */
const app = createApp();

export default app;

export type { Env } from './env';
