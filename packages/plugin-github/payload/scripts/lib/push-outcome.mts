import { writeSync } from 'node:fs';

/** Ops still queued for each ledger when a push run ended. */
export interface PendingCounts {
  backlog: number;
  decisions: number;
}

/**
 * How one `push` run ended, as the line it writes last.
 *
 * `error` is the first line the run wrote through `console.error`, or null when the run exited
 * 0 or failed without one. `pending` is null when the queue could not be counted at exit.
 */
export interface PushOutcome {
  at: string;
  exitCode: number;
  error: string | null;
  pending: PendingCounts | null;
}

/**
 * Starts the one line a push run writes last, so a reader finds it in a log that also holds
 * free-form output. The plugin's doctor check matches this exact text, so changing it is a
 * format change on both sides.
 */
export const PUSH_OUTCOME_PREFIX = 'projects-sync push outcome ';

export function formatPushOutcome(outcome: PushOutcome): string {
  return `${PUSH_OUTCOME_PREFIX}${JSON.stringify(outcome)}`;
}

/**
 * Writes one {@link formatPushOutcome} line to stdout when the process exits, whatever path
 * ends it. A push exits through `process.exit` from a dozen places, so recording at each one
 * would miss the next one added.
 *
 * Wraps `console.error` to keep the first error line. The write uses `writeSync` on fd 1,
 * because an `exit` listener cannot wait on an asynchronous stream write.
 *
 * @param countPending Counts the queue at exit. A throw records `pending: null`, never a crash.
 */
export function recordPushOutcomeOnExit(
  countPending: () => PendingCounts,
  now: () => string = () => new Date().toISOString(),
): void {
  let firstError: string | null = null;
  const writeError = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    if (firstError === null)
      firstError = args.map(String).join(' ').split('\n')[0] ?? null;
    writeError(...args);
  };

  process.on('exit', (code) => {
    let pending: PendingCounts | null;
    try {
      pending = countPending();
    } catch {
      pending = null;
    }
    const line = formatPushOutcome({
      at: now(),
      exitCode: code,
      error: code === 0 ? null : firstError,
      pending,
    });
    try {
      writeSync(1, `${line}\n`);
    } catch {
      // A closed stdout leaves nothing to record into, and an exit listener must not throw.
    }
  });
}
