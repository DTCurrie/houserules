import type { Except } from 'type-fest';

import { TargetRepo } from './core/fs-target.js';
import { MANIFEST_PATH, type KitManifest } from './core/manifest.js';
import type { SettingsSignature } from './merge-settings.js';
import type { EffectOp, PlanResult, PruneResult } from './plan.js';

/**
 * What apply() consumes: a plan result minus the fields it has no use for, plus the
 * prune. Derived from `PlanResult` rather than restated, so a field added there
 * cannot silently go unconsidered here. `signature` widens to optional because a
 * caller may apply without recording one.
 */
export type ApplyInput = Except<
  PlanResult,
  'advisories' | 'plannedDests' | 'signature'
> & {
  signature?: SettingsSignature | null;
  prune?: PruneResult | null;
};

export interface ApplyOptions {
  kitVersion: string;
  moduleIds: string[];
  previousManifest?: KitManifest | null;
  /** Restrict writes to these dests (doctor --fix). Omit to write the whole plan. */
  paths?: Set<string>;
}

export interface WrittenEntry {
  dest: string;
  op: EffectOp | 'merge';
}

export interface ApplyResult {
  written: WrittenEntry[];
  manifest: KitManifest;
}

/**
 * Executes a computed plan. This is the only code in the kit that writes to a target
 * repo, and it adds no decisions of its own. Every effect here was already produced by
 * `computeEffects()` and shown to the user, and every write goes through `TargetRepo`,
 * so "what a run would touch" and "what a run did touch" come from the same code.
 *
 * @param paths Restricts writes to this subset of dests (`doctor --fix` reconciling
 * only what it reported). Omit to write everything the plan produces.
 * @returns What was written, and the manifest receipt to record.
 */
export function apply(
  root: string,
  { effects, settingsPlan, signature = null, prune = null }: ApplyInput,
  { kitVersion, moduleIds, previousManifest = null, paths }: ApplyOptions,
): ApplyResult {
  const repo = new TargetRepo(root);
  const written: WrittenEntry[] = [];
  const files: Record<string, string> = { ...(previousManifest?.files ?? {}) };
  const wanted = (dest: string) => paths === undefined || paths.has(dest);

  for (const { action, op, content, hash } of effects) {
    if (!wanted(action.dest)) continue;
    // `region` is manifest-tracked like copy/write, but its recorded hash is the
    // managed BODY's, not the host file's. The rest of that file is the user's.
    const owned =
      action.kind === 'copy' ||
      action.kind === 'write' ||
      action.kind === 'region';
    if (op === 'skip-exists' || op === 'skip-modified') continue;
    if (op === 'skip-identical') {
      if (owned && hash) files[action.dest] = hash; // adopt identical file as kit-owned
      continue;
    }
    if (content === null) continue;
    // Only copy/write carry a mode. A seed never does.
    const mode = 'mode' in action ? action.mode : undefined;
    repo.write(action.dest, content, mode);
    if (owned && hash) files[action.dest] = hash;
    written.push({ dest: action.dest, op });
  }

  // The only removal path. It still runs through apply so dry-run renders the same
  // deletes. computePrune already hash-guarded every entry.
  for (const { dest } of prune?.deletes ?? []) {
    if (repo.exists(dest)) repo.remove(dest);
    delete files[dest];
    written.push({ dest, op: 'delete' });
  }

  if (
    settingsPlan &&
    settingsPlan.changes.length &&
    settingsPlan.text &&
    wanted(settingsPlan.dest)
  ) {
    if (settingsPlan.existedBefore) repo.backupOnce(settingsPlan.dest);
    repo.write(settingsPlan.dest, settingsPlan.text);
    written.push({
      dest: settingsPlan.dest,
      op: settingsPlan.existedBefore ? 'merge' : 'create',
    });
  }

  // Keep the manifest byte-stable when nothing changed, so a re-run is a true
  // no-op (idempotency is asserted as a tree hash in tests).
  const stable =
    previousManifest &&
    !written.length &&
    previousManifest.kitVersion === kitVersion &&
    JSON.stringify(previousManifest.modules) === JSON.stringify(moduleIds) &&
    JSON.stringify(previousManifest.files) === JSON.stringify(files) &&
    JSON.stringify(previousManifest.settings ?? null) ===
      JSON.stringify(signature);
  const manifest: KitManifest = stable
    ? previousManifest
    : {
        kitVersion,
        installedAt: new Date().toISOString(),
        modules: moduleIds,
        files,
        ...(signature ? { settings: signature } : {}),
      };
  if (!stable) {
    repo.write(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return { written, manifest };
}
