#!/usr/bin/env node
/**
 * Dev-only tool, never published. Compares every package's `payload/` against its own
 * `payload-dist/` as built, and fails when a directory or file under `payload/` has no
 * counterpart in `payload-dist/`. `scripts` is excluded on both sides: `tsconfig.payload.json`
 * compiles it directly, so it is never copied by this comparison. `__test__` is excluded on
 * both sides too, since a colocated test must never reach the published package.
 *
 * Falsifies AGENTKIT-b947e5: a shared assembler that derives its copy set from what actually
 * exists under `payload/`, rather than a hand-listed set, must never let a new payload
 * directory silently fail to ship.
 *
 * Usage: `node scripts/verify-payload-copy-set.mjs`
 *
 * Requires a prior build (`pnpm build` at the workspace root), since it reads `payload-dist/`
 * as it exists on disk. Exits 1 if any package fails.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const packagesDir = join(repoRoot, 'packages');

const SKIP_TOP_LEVEL_DIRS = new Set(['scripts', '__test__']);

function walkFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__test__') return [];
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
}

function findPayloadPackageDirs() {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name))
    .filter((packageDir) => existsSync(join(packageDir, 'payload')));
}

function verifyPackage(packageDir) {
  const source = join(packageDir, 'payload');
  const dist = join(packageDir, 'payload-dist');
  const failures = [];

  if (!existsSync(dist)) {
    return [`payload-dist is missing — run \`pnpm build\` first`];
  }

  const dirs = readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !SKIP_TOP_LEVEL_DIRS.has(name));

  for (const dir of dirs) {
    const sourceDir = join(source, dir);
    const distDir = join(dist, dir);
    if (!existsSync(distDir)) {
      failures.push(`payload-dist/${dir} is missing`);
      continue;
    }
    for (const file of walkFiles(sourceDir)) {
      const rel = relative(sourceDir, file);
      const distFile = join(distDir, rel);
      if (!existsSync(distFile)) {
        failures.push(`payload-dist/${dir}/${rel} is missing`);
        continue;
      }
      if (!readFileSync(file).equals(readFileSync(distFile))) {
        failures.push(
          `payload-dist/${dir}/${rel} differs from payload/${dir}/${rel}`,
        );
      }
    }
  }

  return failures;
}

function main() {
  const results = new Map();
  for (const packageDir of findPayloadPackageDirs()) {
    const manifest = JSON.parse(
      readFileSync(join(packageDir, 'package.json'), 'utf8'),
    );
    results.set(manifest.name, verifyPackage(packageDir));
  }

  const sortedNames = [...results.keys()].sort();
  for (const name of sortedNames) {
    const failures = results.get(name);
    if (failures.length === 0) {
      console.log(`PASS  ${name}`);
      continue;
    }
    console.log(`FAIL  ${name}`);
    for (const failure of failures) {
      console.log(`      - ${failure}`);
    }
  }

  const failedPackages = sortedNames.filter(
    (name) => results.get(name).length > 0,
  );
  console.log('');
  console.log(
    `${sortedNames.length - failedPackages.length}/${sortedNames.length} packages passed`,
  );

  if (failedPackages.length > 0) {
    console.log(`Failed: ${failedPackages.join(', ')}`);
    process.exit(1);
  }
}

main();
