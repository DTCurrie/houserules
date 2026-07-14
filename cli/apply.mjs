// The only code in the kit that writes to a target repo (claude-kit CLI).
// Everything it does was first computed by plan.computeEffects() and shown to
// the user; apply() just executes that result and records the receipt.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const MANIFEST_PATH = '.claude/kit-manifest.json';

export function apply(
  root,
  { effects, settingsPlan, signature = null, prune = null },
  { kitVersion, moduleIds, previousManifest = null },
) {
  const written = [];
  const files = { ...(previousManifest?.files ?? {}) };

  for (const { action, op, content, hash } of effects) {
    const owned = action.kind === 'copy' || action.kind === 'write';
    if (op === 'skip-exists' || op === 'skip-modified') continue;
    if (op === 'skip-identical') {
      if (owned) files[action.dest] = hash; // adopt identical file as kit-owned
      continue;
    }
    const destAbs = join(root, action.dest);
    mkdirSync(dirname(destAbs), { recursive: true });
    writeFileSync(destAbs, content);
    if (action.mode) chmodSync(destAbs, action.mode);
    if (owned) files[action.dest] = hash;
    written.push({ dest: action.dest, op });
  }

  // Prune: delete retired kit-owned files (computed by computePrune, hash-guarded
  // there) and drop them from the manifest. A prune is the only removal path; it
  // still runs through apply so dry-run could render the same deletes.
  for (const { dest } of prune?.deletes ?? []) {
    const destAbs = join(root, dest);
    if (existsSync(destAbs)) rmSync(destAbs, { force: true });
    delete files[dest];
    written.push({ dest, op: 'delete' });
  }

  if (settingsPlan && settingsPlan.changes.length) {
    const destAbs = join(root, settingsPlan.dest);
    if (settingsPlan.existedBefore) {
      const backup = `${destAbs}.bak`;
      if (!existsSync(backup)) copyFileSync(destAbs, backup);
    }
    mkdirSync(dirname(destAbs), { recursive: true });
    writeFileSync(destAbs, settingsPlan.text);
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
  const manifest = stable
    ? previousManifest
    : {
        kitVersion,
        installedAt: new Date().toISOString(),
        modules: moduleIds,
        files,
        ...(signature ? { settings: signature } : {}),
      };
  if (!stable) {
    const manifestAbs = join(root, MANIFEST_PATH);
    mkdirSync(dirname(manifestAbs), { recursive: true });
    writeFileSync(manifestAbs, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return { written, manifest };
}
