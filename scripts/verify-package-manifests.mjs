#!/usr/bin/env node
/**
 * Dev-only tool, never published. Asserts that every publishable package's `package.json`
 * carries the fields a published package needs. It reads JSON and packs nothing, so it runs in
 * every `pnpm check`. What only a packed tarball shows is `verify-tarballs.mjs`'s job.
 *
 * Usage: `node scripts/verify-package-manifests.mjs`
 *
 * Exits 1 if any package lacks a field.
 */

import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findPublishablePackageDirs,
  readManifest,
} from './lib/publishable-packages.mjs';

const REQUIRED_FIELDS = [
  'name',
  'version',
  'license',
  'author',
  'description',
  'repository',
];

/** One failure line per field `manifest` lacks, `publishConfig.access` included. */
export function findMissingFields(manifest) {
  const failures = REQUIRED_FIELDS.filter(
    (field) => manifest[field] === undefined,
  ).map((field) => `package.json is missing "${field}"`);
  if (manifest.publishConfig?.access === undefined) {
    failures.push('package.json is missing "publishConfig.access"');
  }
  return failures;
}

function main() {
  const results = findPublishablePackageDirs().map((packageDir) => {
    const manifest = readManifest(packageDir);
    return {
      name: manifest.name ?? basename(packageDir),
      failures: findMissingFields(manifest),
    };
  });
  const failing = results
    .filter(({ failures }) => failures.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const { name, failures } of failing) {
    console.log(`FAIL  ${name}`);
    for (const failure of failures) console.log(`      - ${failure}`);
  }
  console.log(
    `${results.length - failing.length}/${results.length} package manifests passed`,
  );
  if (failing.length > 0) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
