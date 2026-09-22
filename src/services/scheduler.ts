import { createDb } from '../db';
import type { Env } from '../env';
import { pruneLoginAttempts } from './login-rate-limit';

/**
 * Periodic work, run from the Worker's `scheduled` trigger.
 *
 * Each task is independent and each is caught: one failing job must not stop the
 * others, and a throw here would show up as a red herring in the cron metrics
 * rather than a diagnosable error.
 *
 * Phase 1 wires the trigger and carries the one job that exists today (pruning
 * login attempts, which the sign-in path also does opportunistically). The
 * low-stock digest joins here in the catalog phase, when there are products with
 * reorder points to check.
 */
export async function runScheduledTasks(
  env: Env,
  only?: string,
  cron?: string,
): Promise<void> {
  const db = createDb(env.DB);

  const jobs: Record<string, () => Promise<void>> = {
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
