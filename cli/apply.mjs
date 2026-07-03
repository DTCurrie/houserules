// The only code in the kit that writes to a target repo (claude-kit CLI).
// Everything it does was first computed by plan.computeEffects() and shown to
// the user; apply() just executes that result and records the receipt.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const MANIFEST_PATH = '.claude/kit-manifest.json';

export function apply(
  root,
  { effects, settingsPlan },
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
    JSON.stringify(previousManifest.files) === JSON.stringify(files);
  const manifest = stable
    ? previousManifest
    : {
        kitVersion,
        installedAt: new Date().toISOString(),
        modules: moduleIds,
        files,
      };
  if (!stable) {
    const manifestAbs = join(root, MANIFEST_PATH);
    mkdirSync(dirname(manifestAbs), { recursive: true });
    writeFileSync(manifestAbs, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return { written, manifest };
}
