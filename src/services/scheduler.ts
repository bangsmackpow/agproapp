import { createDb } from '../db';
import type { Env } from '../env';
import { pruneLoginAttempts } from './login-rate-limit';
import { runReorderDigest } from './reorder-digest';

/**
 * Periodic work, run from the Worker's `scheduled` trigger.
 *
 * Each task is independent and each is caught: one failing job must not stop the
 * others, and a throw here surfaces as a red herring in the cron metrics rather
 * than a diagnosable error.
 *
 * Jobs run on every trigger and are responsible for their own idempotency — the
 * digest claims a day in `settings.lastDigestAt` precisely so a cron retry cannot
 * mail the same list twice.
 */
export async function runScheduledTasks(
  env: Env,
  only?: string,
  cron?: string,
): Promise<void> {
  const db = createDb(env.DB);

  const jobs: Record<string, () => Promise<void>> = {
    digest: async () => {
      await runReorderDigest(env);
    },
    prune: async () => {
      await pruneLoginAttempts(db);
    },
  };

  const names = only && jobs[only] ? [only] : Object.keys(jobs);

  for (const name of names) {
    try {
      await jobs[name]!();
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: `scheduled job failed: ${name}`,
          cron: cron ?? null,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
