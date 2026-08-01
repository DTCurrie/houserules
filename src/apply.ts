// The only code in the kit that writes to a target repo (claude-kit CLI).
// Everything it does was first computed by plan.computeEffects() and shown to
// the user; apply() just executes that result and records the receipt.
//
// Every write goes through TargetRepo (src/core/fs-target.ts), so "what a run would
// touch" and "what a run did touch" are answered by the same code.

import { TargetRepo } from './core/fs-target.js';
import type {
  ApplyInput,
  ApplyOptions,
  ApplyResult,
  KitManifest,
  WrittenEntry,
} from './types.js';

export const MANIFEST_PATH = '.claude/kit-manifest.json';

export function apply(
  root: string,
  { effects, settingsPlan, signature = null, prune = null }: ApplyInput,
  { kitVersion, moduleIds, previousManifest = null, paths }: ApplyOptions,
): ApplyResult {
  const repo = new TargetRepo(root);
  const written: WrittenEntry[] = [];
  const files: Record<string, string> = { ...(previousManifest?.files ?? {}) };
  // `paths` restricts writes to a chosen subset (doctor --fix reconciling only the
  // files it reported). Absent means "write everything this plan produces".
  const wanted = (dest: string) => paths === undefined || paths.has(dest);

  for (const { action, op, content, hash } of effects) {
    if (!wanted(action.dest)) continue;
    // `region` is manifest-tracked like copy/write, but its recorded hash is the
    // managed BODY's, not the host file's — the rest of that file is the user's.
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
    // Only copy/write carry a mode; a seed never does.
    const mode = 'mode' in action ? action.mode : undefined;
    repo.write(action.dest, content, mode);
    if (owned && hash) files[action.dest] = hash;
    written.push({ dest: action.dest, op });
  }

  // Prune: delete retired kit-owned files (computed by computePrune, hash-guarded
  // there) and drop them from the manifest. A prune is the only removal path; it
  // still runs through apply so dry-run could render the same deletes.
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
