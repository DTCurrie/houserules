import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  manifestOf,
  readJson,
  sha256,
  writeManifest,
} from '#test/installed-tree';

/** Config the update tests share to opt an install into committing its scripts. */
export const COMMITTED_SCRIPTS = { config: { scripts: { commit: true } } };

export const KIT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

export const KIT_VERSION = readJson<{ version: string }>(
  join(KIT_ROOT, 'package.json'),
).version;

export const LINT_SCRIPT = '.claude/scripts/lint-format-fix.mjs';

/** Rewrites the lint script and its manifest hash so the install reads as stale. */
export function makeLintScriptStale(root: string): void {
  writeFileSync(join(root, LINT_SCRIPT), '// OLD KIT VERSION\n');
  const manifest = manifestOf(root);
  manifest.files[LINT_SCRIPT] = sha256('// OLD KIT VERSION\n');
  writeManifest(root, manifest);
}
