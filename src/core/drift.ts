import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { truncateDiff, unifiedDiff } from './diff.js';
import { classifyFrontmatter, splitFrontmatter } from './frontmatter.js';
import { bodyHashes, wholeFileHash } from './manifest.js';
import type { KitManifest } from './manifest.js';
import { extractBody } from './regions.js';
import type { Effect, PruneResult } from '../plan.js';

/**
 * Why a file no longer matches what the kit would write.
 *
 * `stale` and `yours` are the distinction the drift engine exists for. `stale` means
 * disk matches what the kit last wrote but the kit's canonical content moved on, so the
 * KIT changed and `update` refreshes it silently. `yours` means disk differs from what
 * the kit last wrote, so YOU changed it, and it is never overwritten without `--force`.
 * A content-hash lockfile cannot tell these apart. The manifest can, because it records
 * what the kit itself last wrote. Do not collapse them.
 *
 * `conflict` is both at once: you edited the file AND the kit shipped a newer version of
 * it since. That is the only local edit that leaves you a decision to make, which is why
 * it is split out. A settled `yours` is a fact about the install, not a problem with it,
 * and reporting the two the same way leaves doctor permanently yellow on a repo that
 * followed the kit's own advice to edit a file.
 */
export type FileStatus =
  'ok' | 'missing' | 'stale' | 'yours' | 'conflict' | 'no-marker' | 'orphaned';

export interface FileDrift {
  path: string;
  module?: string;
  status: FileStatus;
  /**
   * You edited this file. Set on `yours` and `conflict`, and on an `orphaned` file that
   * the prune path kept BECAUSE you edited it. Callers use it to decide what is
   * actionable: a deliberate edit should not hold an exit code red forever.
   */
  yours?: boolean;
  /**
   * Unified diff (on disk → canonical). Present for `stale`, `yours`, `conflict`, and
   * `no-marker`.
   */
  diff?: string;
  /**
   * A body-owned file whose frontmatter you customized AND whose shipped default has moved
   * since. Deliberately an annotation rather than a {@link FileStatus}, for two reasons. It
   * is orthogonal to the body, which has its own status on the same entry. And a status
   * would enter `driftedFiles()` and hold the exit code red over a file that is behaving
   * exactly as designed.
   */
  defaultMoved?: boolean;
}

export interface DriftReport {
  files: FileDrift[];
}

export interface ComputeDriftOptions {
  /**
   * The receipt of what the kit last wrote. Without it a local edit cannot be told from
   * a conflict, because the comparison is recorded hash against canonical hash.
   */
  manifest: KitManifest | null;
  prune?: PruneResult | null;
}

/** Statuses `doctor --fix` reconciles without asking. A local edit needs --force. */
export const FIXABLE: readonly FileStatus[] = ['missing', 'stale', 'no-marker'];

/** Statuses that ARE a local edit, so `--fix` touches them only under `--force`. */
export const FORCE_ONLY: readonly FileStatus[] = ['yours', 'conflict'];

/**
 * You changed this file. Answers a different question from {@link FORCE_ONLY}, which is
 * about what a rewrite would resolve. This is about who caused the divergence, so it also
 * covers a retired file the prune path kept BECAUSE you had edited it.
 */
export function isLocalEdit(file: FileDrift): boolean {
  return file.yours === true || FORCE_ONLY.includes(file.status);
}

function readText(root: string, relativePath: string): string | null {
  try {
    return readFileSync(join(root, relativePath), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Which side of a local edit the kit is on. `skip-modified` only establishes that YOU
 * changed the file. Comparing what the kit last wrote against what it would write now
 * establishes whether the KIT changed too, which is the difference between a settled
 * edit and a merge you still owe.
 */
function editedStatus(
  recordedHash: string | undefined,
  canonicalHash: string | undefined,
): 'yours' | 'conflict' {
  if (recordedHash === undefined || canonicalHash === undefined) return 'yours';
  return recordedHash === canonicalHash ? 'yours' : 'conflict';
}

/**
 * Classifies ONE effect against what is on disk. Pure: every filesystem touch arrives
 * through `readHost`, which is called at most once and only for the statuses that need
 * content.
 *
 * @param readHost Returns the destination file's current text, or null if it is absent.
 *   For a region action this is the whole host file, not the region body.
 * @param recordedHash The manifest's hash for this dest, which is what the kit last
 *   wrote. For a region that is the BODY's hash, matching what `Effect.hash` carries.
 * @param recordedDefaultFrontmatter A body action's manifest-recorded default
 *   frontmatter hash, used to tell a customization the kit's shipped default has moved
 *   past from one it has not. Ignored for every other action kind.
 */
export function classifyEffect(
  effect: Effect,
  readHost: () => string | null,
  recordedHash: string | undefined,
  recordedDefaultFrontmatter?: string,
): FileDrift {
  const { action, op, content, hash } = effect;
  const base = { path: action.dest, module: action.module };

  const bodyHost =
    action.kind === 'body' && op !== 'create' ? readHost() : null;
  const defaultMoved =
    action.kind === 'body' &&
    op !== 'create' &&
    classifyFrontmatter({
      onDisk: createHash('sha256')
        .update(splitFrontmatter(bodyHost ?? '').frontmatter)
        .digest('hex'),
      recordedDefault: recordedDefaultFrontmatter,
      shippedDefault: effect.frontmatterHash ?? '',
    }) === 'default-moved';
  const annotation = defaultMoved ? { defaultMoved: true } : {};

  // A seed whose destination exists is the user's file, by design. Not drift.
  if (op === 'skip-exists' || op === 'skip-identical') {
    return { ...base, ...annotation, status: 'ok' };
  }
  if (op === 'create') {
    return { ...base, status: 'missing' };
  }

  const edited = op === 'skip-modified';
  const status = edited ? editedStatus(recordedHash, hash) : 'stale';

  if (action.kind === 'region') {
    const host = readHost();
    const body = host === null ? null : extractBody(host, action.region);
    if (body === null) {
      // The host file is there but our markers are gone. Someone deleted them,
      // or the file predates the region. `--fix` re-inserts at the anchor without
      // disturbing anything else.
      return { ...base, status: 'no-marker' };
    }
    return {
      ...base,
      status,
      yours: edited,
      diff: truncateDiff(unifiedDiff(body, action.body)),
    };
  }

  if (action.kind === 'body') {
    const diskBody = bodyHost === null ? '' : splitFrontmatter(bodyHost).body;
    // `content` is the disk frontmatter spliced onto the canonical body, so re-splitting
    // it recovers the canonical body without re-deriving it from the payload file.
    const canonicalBody = splitFrontmatter(
      content?.toString('utf8') ?? '',
    ).body;
    return {
      ...base,
      ...annotation,
      status,
      yours: edited,
      diff: truncateDiff(unifiedDiff(diskBody, canonicalBody)),
    };
  }

  const canonical = content?.toString('utf8') ?? '';
  return {
    ...base,
    status,
    yours: edited,
    diff: truncateDiff(unifiedDiff(readHost() ?? '', canonical)),
  };
}

/**
 * The orphan half of a drift report. Pure: derived entirely from the prune result.
 *
 * Orphans are recorded by the manifest but no longer produced by any enabled module.
 * `computePrune` already refuses to propose deleting a shared host file.
 */
export function orphanDrift(prune?: PruneResult | null): FileDrift[] {
  const files: FileDrift[] = [];
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
  return files;
}

/**
 * Reports what on disk no longer matches what the kit would write, and why.
 *
 * Derived from the effects `computeEffects()` already produced rather than
 * re-implementing the comparison, so doctor and update cannot disagree about what has
 * drifted. The per-file decision is {@link classifyEffect}, which is pure. This function
 * is only the filesystem shell around it.
 *
 * @param effects From `computeEffects()`. The canonical content per path.
 */
/**
 * The recorded hash to compare an effect's content against, per action kind.
 *
 * A body-owned dest whose manifest entry is still the legacy whole-file string reads as
 * undefined here, which `editedStatus` treats as `yours`. The entry predates body
 * ownership, so the kit cannot prove its own copy of the body moved on, and `conflict`
 * would be an alarm it cannot justify.
 */
function recordedHashFor(
  manifest: KitManifest | null,
  effect: Effect,
): string | undefined {
  return effect.action.kind === 'body'
    ? bodyHashes(manifest, effect.action.dest)?.body
    : wholeFileHash(manifest, effect.action.dest);
}

/** The manifest's recorded default frontmatter hash for a body-owned dest, or undefined. */
function recordedDefaultFrontmatterFor(
  manifest: KitManifest | null,
  effect: Effect,
): string | undefined {
  return effect.action.kind === 'body'
    ? bodyHashes(manifest, effect.action.dest)?.frontmatter
    : undefined;
}

export function computeDrift(
  root: string,
  effects: Effect[],
  { manifest, prune }: ComputeDriftOptions,
): DriftReport {
  const files = effects.map((effect) =>
    classifyEffect(
      effect,
      () => readText(root, effect.action.dest),
      recordedHashFor(manifest, effect),
      recordedDefaultFrontmatterFor(manifest, effect),
    ),
  );
  return { files: [...files, ...orphanDrift(prune)] };
}

export function isClean(report: DriftReport): boolean {
  return report.files.every((file) => file.status === 'ok');
}

export function driftedFiles(report: DriftReport): FileDrift[] {
  return report.files.filter((file) => file.status !== 'ok');
}
