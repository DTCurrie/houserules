/**
 * Where the daily version check caches what the registry said. Local state, never tracked: the
 * core's `.claude/.gitignore` block lists it. Written by the payload's `version-check.mjs`, read
 * by the `payload-sync` hook and by `doctor`.
 */
export const VERSION_CHECK_CACHE_PATH = '.claude/state/version-check.json';

/** How long a check or an announcement counts as current: one day, in milliseconds. */
export const VERSION_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** One package's last announcement, so the same version is not announced twice in a day. */
interface VersionAnnouncement {
  /** The `latest` version the line named. */
  version: string;
  /** ISO 8601 time the line was printed. */
  at: string;
}

/** The shape of {@link VERSION_CHECK_CACHE_PATH}. */
export interface VersionCheckCache {
  /** ISO 8601 time of the last registry check, written by the checker even when every lookup failed. */
  checkedAt: string;
  /** Package name → the registry's `latest` dist-tag. A package whose lookup failed is absent. */
  latest: Record<string, string>;
  /** Package name → its last announcement. Written by the hook, preserved by the checker. */
  announced?: Record<string, VersionAnnouncement>;
}
