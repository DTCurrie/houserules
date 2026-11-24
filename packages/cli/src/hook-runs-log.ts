/**
 * Where the hook dispatcher records each dispatched script run. Local state, never tracked: the
 * core's `.claude/.gitignore` block lists both paths. Written by the payload's
 * `hook-dispatch.mjs`, which mirrors both paths since a payload script cannot import them, and
 * read by `report`'s hook health.
 */
export const HOOK_RUNS_LOG_PATH = '.claude/state/hook-runs.jsonl';

/** The one rotated generation: the log moves here when an append finds it past the dispatcher's 1 MiB cap. */
export const HOOK_RUNS_ROTATED_PATH = '.claude/state/hook-runs.1.jsonl';

/** One line of {@link HOOK_RUNS_LOG_PATH}: one dispatched script's run. */
export interface HookRunRecord {
  /** When the script finished, as an ISO 8601 string. */
  at: string;
  /** The hook event the dispatcher ran it for, such as `Stop` or `PreToolUse`. */
  event: string;
  /** The script's basename under `.claude/scripts/`, such as `guard-bash.mjs`. */
  script: string;
  /** The script's exit code, or `null` when it was killed by a signal or its timeout. */
  exitCode: number | null;
  /** Whether the script wrote anything to stdout or stderr. */
  hasOutput: boolean;
  /** Wall time from spawn to exit, in milliseconds. */
  durationMilliseconds: number;
}

/**
 * The path a run took. A run that exited 0 and printed nothing took the clean path. Any output
 * or any other exit is the dirty path, the one that costs the session a turn.
 */
export function hookRunPath(record: HookRunRecord): 'clean' | 'dirty' {
  return record.exitCode === 0 && !record.hasOutput ? 'clean' : 'dirty';
}
