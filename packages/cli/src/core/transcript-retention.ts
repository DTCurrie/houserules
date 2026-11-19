import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MS_PER_DAY = 86_400_000;

/** What Claude Code keeps transcripts for when no settings file sets `cleanupPeriodDays`. */
const RETENTION_DEFAULT_DAYS = 30;

/** How many days short of the retention period a first transcript still reads as truncated. */
const RETENTION_MARGIN_DAYS = 2;

/** The effective `cleanupPeriodDays`, and the settings file that set it. */
interface Retention {
  days: number;
  /** Absolute path of the winning settings file, or `null` when the default applies. */
  source: string | null;
}

function readCleanupDays(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const days = (parsed as Record<string, unknown>).cleanupPeriodDays;
    return typeof days === 'number' && Number.isInteger(days) && days >= 1
      ? days
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves `cleanupPeriodDays` the way Claude Code's settings precedence orders the files
 * houserules can see: project local, then shared project, then user. The user file lives in
 * `configDir`, which is `CLAUDE_CONFIG_DIR` or `~/.claude`. Managed and `--settings` sources
 * are not readable from here and are not consulted. A missing file, malformed JSON, or a
 * value Claude Code rejects (not a whole number of at least 1) is skipped, never thrown.
 */
export function resolveRetention(
  projectRoot: string,
  configDir: string,
): Retention {
  const candidates = [
    join(projectRoot, '.claude', 'settings.local.json'),
    join(projectRoot, '.claude', 'settings.json'),
    join(configDir, 'settings.json'),
  ];
  for (const file of candidates) {
    const days = readCleanupDays(file);
    if (days !== undefined) return { days, source: file };
  }
  return { days: RETENTION_DEFAULT_DAYS, source: null };
}

/**
 * The sentence naming the retention setting, shared by `report` and `doctor`. The unset form
 * names the default, and the set form names the value and its file.
 */
export function describeRetention(retention: Retention): string {
  if (retention.source === null)
    return `Claude Code deletes transcripts after cleanupPeriodDays, default ${RETENTION_DEFAULT_DAYS}`;
  return `Claude Code deletes transcripts after cleanupPeriodDays, set to ${retention.days} in ${retention.source}`;
}

/** The oldest transcript in a directory by mtime, which is what Claude Code's sweep reads. */
export function oldestTranscript(
  dir: string,
): { file: string; mtimeMs: number; day: string } | null {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return null;
  }
  let oldest: { file: string; mtimeMs: number } | null = null;
  for (const name of names) {
    const file = join(dir, name);
    try {
      const { mtimeMs } = statSync(file);
      if (oldest === null || mtimeMs < oldest.mtimeMs)
        oldest = { file, mtimeMs };
    } catch {
      continue;
    }
  }
  if (oldest === null) return null;
  return {
    ...oldest,
    day: new Date(oldest.mtimeMs).toISOString().slice(0, 10),
  };
}

/**
 * Warnings about a corpus that may be truncated. A first transcript within the margin below
 * the retention period suggests the oldest sessions are already gone.
 */
export function windowWarnings(
  firstTimestamp: number,
  since: number | undefined,
  sinceFlag: string | undefined,
  now: number,
  retention: Retention,
): string[] {
  const oldest = new Date(firstTimestamp).toISOString().slice(0, 10);
  const sentence = describeRetention(retention);
  if (since !== undefined && since < firstTimestamp)
    return [
      `(warning: --since ${sinceFlag} predates the oldest transcript, ${oldest}. ${sentence})`,
    ];
  const ageDays = (now - firstTimestamp) / MS_PER_DAY;
  const windowStart = retention.days - RETENTION_MARGIN_DAYS;
  if (ageDays >= windowStart && ageDays <= retention.days)
    return [`(warning: the oldest transcript is ${oldest}. ${sentence})`];
  return [];
}
