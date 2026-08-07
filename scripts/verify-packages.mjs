#!/usr/bin/env node
/**
 * Dev-only tool, never published. Packs every publishable package into a real tarball with
 * `npm pack` and asserts what must and must not be inside it, catching the drift a green
 * build cannot: a leaked `__test__` dir, a `vitest` import, or a missing README or LICENSE.
 *
 * Usage: `node scripts/verify-packages.mjs`
 *
 * Requires a prior build (`pnpm build` at the workspace root), since it packs `dist/` and
 * `payload-dist/` as they exist on disk. Exits 1 if any package fails any assertion.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const packagesDir = join(repoRoot, 'packages');

const REQUIRED_PACKAGE_JSON_FIELDS = [
  'name',
  'version',
  'license',
  'author',
  'description',
  'repository',
];

const TARBALL_ENTRIES_TO_SCAN_FOR_VITEST = new Set(['.js', '.mjs', '.d.ts']);

function findPublishablePackageDirs() {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name))
    .filter((packageDir) => {
      const manifest = JSON.parse(
        readFileSync(join(packageDir, 'package.json'), 'utf8'),
      );
      return manifest.private !== true;
    });
}

function packTarball(packageDir, destinationDir) {
  // A package's own `prepack` lifecycle script (e.g. a rebuild through wireit) writes its own
  // lines to stdout ahead of npm's `--json` summary, so we locate the tarball by directory
  // listing rather than trying to isolate npm's JSON line from that noise.
  execFileSync('npm', ['pack', '--pack-destination', destinationDir], {
    cwd: packageDir,
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const [tarballName] = readdirSync(destinationDir).filter((name) =>
    name.endsWith('.tgz'),
  );
  return join(destinationDir, tarballName);
}

function listTarballEntries(tarballPath) {
  return execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0);
}

function extractTarball(tarballPath, destinationDir) {
  execFileSync('tar', ['-xzf', tarballPath, '-C', destinationDir]);
}

function assertNoTestDirectories(entries, failures) {
  for (const entry of entries) {
    if (entry.split('/').includes('__test__')) {
      failures.push(`ships a __test__ path: ${entry}`);
    }
  }
}

function assertNoVitestImports(
  entries,
  extractedRoot,
  declaresVitestPeerDependency,
  failures,
) {
  // A package that declares vitest as a peerDependency ships its published API in terms of
  // vitest on purpose, per CLAUDE.md's "packages/test" section. Everywhere else, vitest is a
  // dev-only tool and its presence in a shipped file means a test helper leaked into the build.
  if (declaresVitestPeerDependency) return;
  for (const entry of entries) {
    const dotIndex = entry.lastIndexOf('.');
    const extension = dotIndex === -1 ? '' : entry.slice(dotIndex);
    if (!TARBALL_ENTRIES_TO_SCAN_FOR_VITEST.has(extension)) continue;
    const extractedPath = join(extractedRoot, entry);
    const contents = readFileSync(extractedPath, 'utf8');
    if (contents.includes('vitest')) {
      failures.push(`imports vitest: ${entry}`);
    }
  }
}

function assertReadmeAndLicensePresent(entries, failures) {
  const hasReadme = entries.some((entry) =>
    /^package\/readme(\.\w+)?$/i.test(entry),
  );
  const hasLicense = entries.some((entry) =>
    /^package\/license(\.\w+)?$/i.test(entry),
  );
  if (!hasReadme) failures.push('missing a README in the tarball root');
  if (!hasLicense) failures.push('missing a LICENSE in the tarball root');
}

function assertPackageJsonFields(packageDir, failures) {
  const manifest = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8'),
  );
  for (const field of REQUIRED_PACKAGE_JSON_FIELDS) {
    if (manifest[field] === undefined) {
      failures.push(`package.json is missing "${field}"`);
    }
  }
  if (manifest.publishConfig?.access === undefined) {
    failures.push('package.json is missing "publishConfig.access"');
  }
}

function verifyPackage(packageDir, workDir) {
  const packDestination = mkdtempSync(join(workDir, 'pack-'));
  const extractDestination = mkdtempSync(join(workDir, 'extract-'));
  const failures = [];

  const manifest = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8'),
  );
  const declaresVitestPeerDependency =
    manifest.peerDependencies?.vitest !== undefined;
  assertPackageJsonFields(packageDir, failures);

  const tarballPath = packTarball(packageDir, packDestination);
  const entries = listTarballEntries(tarballPath);
  extractTarball(tarballPath, extractDestination);

  assertNoTestDirectories(entries, failures);
  assertNoVitestImports(
    entries,
    extractDestination,
    declaresVitestPeerDependency,
    failures,
  );
  assertReadmeAndLicensePresent(entries, failures);

  return failures;
}

function reportPackage(packageName, failures) {
  if (failures.length === 0) {
    console.log(`PASS  ${packageName}`);
    return;
  }
  console.log(`FAIL  ${packageName}`);
  for (const failure of failures) {
    console.log(`      - ${failure}`);
  }
}

function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'verify-packages-'));
  const results = new Map();

  try {
    for (const packageDir of findPublishablePackageDirs()) {
      const manifest = JSON.parse(
        readFileSync(join(packageDir, 'package.json'), 'utf8'),
      );
      const failures = verifyPackage(packageDir, workDir);
      results.set(manifest.name, failures);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  const sortedNames = [...results.keys()].sort();
  for (const name of sortedNames) {
    reportPackage(name, results.get(name));
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
