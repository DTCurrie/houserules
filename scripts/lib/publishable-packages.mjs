import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES_DIR = join(import.meta.dirname, '..', '..', 'packages');

/** The parsed `package.json` in `packageDir`. */
export function readManifest(packageDir) {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
}

/** Every workspace package directory whose `package.json` is not `private`, so npm can publish it. */
export function findPublishablePackageDirs() {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES_DIR, entry.name))
    .filter((packageDir) => readManifest(packageDir).private !== true);
}
