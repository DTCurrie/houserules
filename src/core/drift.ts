import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { truncateDiff, unifiedDiff } from './diff.js';
import { extractBody } from './regions.js';
import type { Effect, PruneResult } from '../types.js';

/**
 * Why a file no longer matches what the kit would write.
 *
 * `stale` and `yours` are the distinction the drift engine exists for. `stale` means
 * disk matches what the kit last wrote but the kit's canonical content moved on, so the
 * KIT changed and `update` refreshes it silently. `yours` means disk differs from what
 * the kit last wrote, so YOU changed it, and it is never overwritten without `--force`.
 * A content-hash lockfile cannot tell these apart. The manifest can, because it records
 * what the kit itself last wrote. Do not collapse them.
 */
export type FileStatus =
  'ok' | 'missing' | 'stale' | 'yours' | 'no-marker' | 'orphaned';

export interface FileDrift {
  path: string;
  module?: string;
  status: FileStatus;
  /**
   * You edited this file. Set on `yours`, and on an `orphaned` file that the prune
   * path kept BECAUSE you edited it. Callers use it to decide what is actionable:
   * a deliberate edit should not hold an exit code red forever.
   */
  yours?: boolean;
  /** Unified diff (on disk → canonical). Present for `stale`, `yours`, `no-marker`. */
  diff?: string;
}

export interface DriftReport {
  files: FileDrift[];
}

/** Statuses `doctor --fix` reconciles without asking. `yours` needs --force. */
export const FIXABLE: readonly FileStatus[] = ['missing', 'stale', 'no-marker'];

function readText(root: string, relativePath: string): string | null {
  try {
    return readFileSync(join(root, relativePath), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Reports what on disk no longer matches what the kit would write, and why.
 *
 * Derived from the effects `computeEffects()` already produced rather than
 * re-implementing the comparison, so doctor and update cannot disagree about what has
 * drifted.
 *
 * @param effects From `computeEffects()`. The canonical content per path.
 * @param prune From `computePrune()`. Supplies the orphans.
 */
export function computeDrift(
  root: string,
  effects: Effect[],
  prune?: PruneResult | null,
): DriftReport {
  const files: FileDrift[] = [];

  for (const { action, op, content } of effects) {
    const base = { path: action.dest, module: action.module };

    // A seed whose destination exists is the user's file, by design. Not drift.
    if (op === 'skip-exists' || op === 'skip-identical') {
      files.push({ ...base, status: 'ok' });
      continue;
    }
    if (op === 'create') {
      files.push({ ...base, status: 'missing' });
      continue;
    }

    const canonical = content?.toString('utf8') ?? '';

    if (action.kind === 'region') {
      const host = readText(root, action.dest);
      const body = host === null ? null : extractBody(host, action.region);
      if (body === null) {
        // The host file is there but our markers are gone. Someone deleted them,
        // or the file predates the region. `--fix` re-inserts at the anchor without
        // disturbing anything else.
        files.push({ ...base, status: 'no-marker' });
        continue;
      }
      files.push({
        ...base,
        status: op === 'skip-modified' ? 'yours' : 'stale',
        yours: op === 'skip-modified',
        diff: truncateDiff(unifiedDiff(body, action.body)),
      });
      continue;
    }

    const onDisk = readText(root, action.dest) ?? '';
    files.push({
      ...base,
      status: op === 'skip-modified' ? 'yours' : 'stale',
      yours: op === 'skip-modified',
      diff: truncateDiff(unifiedDiff(onDisk, canonical)),
    });
  }

  // Orphans: recorded by the manifest, no longer produced by any enabled module.
  // computePrune already refuses to propose deleting a shared host file.
  for (const { dest, gone } of prune?.deletes ?? []) {
    if (gone) continue; // already absent — nothing to report
    files.push({ path: dest, status: 'orphaned' });
  }
  // Retired AND locally edited: computePrune kept it precisely because you changed
  // it, so it is reported but must not hold the exit code red. Same reasoning as
  // `yours`.
  for (const dest of prune?.kept ?? []) {
    files.push({ path: dest, status: 'orphaned', yours: true });
  }

  return { files };
}

export function isClean(report: DriftReport): boolean {
  return report.files.every((file) => file.status === 'ok');
}

export function driftedFiles(report: DriftReport): FileDrift[] {
  return report.files.filter((file) => file.status !== 'ok');
}
