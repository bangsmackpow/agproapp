import type { Config } from '@react-router/dev/config';

/**
 * React Router framework mode with SSR.
 *
 * Nothing is prerendered: every screen is behind a session, so there is no
 * meaningful static output to generate.
 */
export default {
  ssr: true,
  appDirectory: 'app',
} satisfies Config;
