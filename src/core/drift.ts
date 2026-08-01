// The drift engine (claude-kit CLI): what on disk no longer matches what the kit
// would write, and — crucially — WHY.
//
// Derived from the effects computeEffects already produced rather than
// re-implementing the comparison. That is deliberate: doctor and update then cannot
// disagree about what is drifted, because they are reading the same computation.
//
// The distinction the whole phase exists for:
//
//   stale  — on disk matches what the kit last wrote, but the kit's canonical
//            content has moved on. The KIT changed. `update` refreshes it silently.
//   yours  — on disk differs from what the kit last wrote. YOU changed it. Reported
//            with a diff and never overwritten without --force.
//
// A content-hash lockfile cannot tell these apart; the manifest can, because it
// records what the kit itself last wrote. Do not collapse them.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { truncateDiff, unifiedDiff } from './diff.js';
import { extractBody } from './regions.js';
import type { Effect, PruneResult } from '../types.js';

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
 * @param effects   from computeEffects() — the canonical content per path
 * @param prune     from computePrune() — supplies the orphans
 */
export function computeDrift(
  root: string,
  effects: Effect[],
  prune?: PruneResult | null,
): DriftReport {
  const files: FileDrift[] = [];

  for (const { action, op, content } of effects) {
    const base = { path: action.dest, module: action.module };

    // A seed whose destination exists is the user's file, by design — not drift.
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
        // The host file is there but our markers are gone — someone deleted them,
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
  // it, so it is reported but must not hold the exit code red — same reasoning as
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
