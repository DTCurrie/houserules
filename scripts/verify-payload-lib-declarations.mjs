#!/usr/bin/env node
/**
 * Dev-only tool, never published. For every package, walks the built `payload-dist/scripts/`
 * output and finds every relative `.mjs` import. Fails when an import has no matching
 * declaration, since an undeclared lib compiles fine but never gets copied into a user's
 * install and the script fails at runtime with ERR_MODULE_NOT_FOUND.
 *
 * A lib counts as declared two ways. A plugin declares its own libs as
 * `api.payload.lib(id, '<name>.mjs')` literal calls in `src/index.ts`, or in the same
 * `for (const name of [...]) { ...lib(id, name)... }` shape `packages/cli/src/modules/core.ts`
 * uses for its hand-maintained manifest. A cross-package lib, one rewritten from
 * `@houserules/payload/<name>` by the `houserules-payload` build step, is recorded instead in
 * that package's own `payload-dist/payload-imports.json` sidecar, so that file is read as a
 * second declaration source. `@houserules/payload` itself is skipped, since it is the source
 * those sidecars point at, not a package with its own install pipeline.
 *
 * Falsifies the shape of AGENTKIT-beef33 across every package at once, rather than the one
 * package `packages/plugin-design/src/__tests__/payload-lib-imports.test.ts` covers.
 *
 * Usage: `node scripts/verify-payload-lib-declarations.mjs`
 *
 * Requires a prior build (`pnpm build` at the workspace root), since it reads `payload-dist/`
 * as it exists on disk. Exits 1 if any package has an undeclared import.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const packagesDir = join(repoRoot, 'packages');

const SKIPPED_PACKAGE_NAMES = new Set(['@houserules/payload']);

function packageNameOf(packageDir) {
  const manifest = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8'),
  );
  return manifest.name;
}

function findPackageDirs() {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name))
    .filter((packageDir) => existsSync(join(packageDir, 'package.json')));
}

function walkMjsFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walkMjsFiles(full);
    return entry.name.endsWith('.mjs') ? [full] : [];
  });
}

function walkTsFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walkTsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function directLibCallNames(content) {
  const matches = content.matchAll(
    /\blib\(\s*[\w.]+\s*,\s*['"]([\w-]+\.mjs)['"]\s*\)/g,
  );
  return [...matches].map((match) => match[1]);
}

function loopDeclaredLibNames(content) {
  const forLoops = content.matchAll(
    /for\s*\(const\s+\w+\s+of\s+\[([\s\S]*?)\]\)\s*\{([\s\S]*?)\n\s*\}/g,
  );
  const names = [];
  for (const [, arrayBody, loopBody] of forLoops) {
    if (!/\blib\(/.test(loopBody)) continue;
    const literals = arrayBody.matchAll(/['"]([\w-]+\.mjs)['"]/g);
    for (const [, name] of literals) names.push(name);
  }
  return names;
}

function ownDeclaredLibNames(packageDir) {
  const names = [];
  for (const file of walkTsFiles(join(packageDir, 'src'))) {
    const content = readFileSync(file, 'utf8');
    names.push(
      ...directLibCallNames(content),
      ...loopDeclaredLibNames(content),
    );
  }
  return names;
}

function sidecarDeclaredLibNames(packageDir) {
  const sidecarPath = join(packageDir, 'payload-dist', 'payload-imports.json');
  if (!existsSync(sidecarPath)) return [];
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  return Object.values(sidecar.libs ?? {}).flat();
}

function importedRelativeLibNames(content) {
  const matches = content.matchAll(
    /from\s+['"]\.\/(?:[\w-]+\/)*([\w-]+)\.mjs['"]/g,
  );
  return [...new Set([...matches].map((match) => match[1]))];
}

function verifyPackage(packageDir) {
  const scriptsDir = join(packageDir, 'payload-dist', 'scripts');
  if (!existsSync(scriptsDir)) return [];

  const declared = new Set(
    [
      ...ownDeclaredLibNames(packageDir),
      ...sidecarDeclaredLibNames(packageDir),
    ].map((name) => name.replace(/\.mjs$/, '')),
  );

  const failures = [];
  for (const file of walkMjsFiles(scriptsDir)) {
    const content = readFileSync(file, 'utf8');
    const relFile = relative(packageDir, file);
    for (const name of importedRelativeLibNames(content)) {
      if (!declared.has(name)) {
        failures.push(`${relFile} imports ${name}.mjs, not declared`);
      }
    }
  }
  return failures;
}

function main() {
  const results = new Map();
  const skipped = [];
  for (const packageDir of findPackageDirs()) {
    const name = packageNameOf(packageDir);
    if (SKIPPED_PACKAGE_NAMES.has(name)) {
      skipped.push(name);
      continue;
    }
    if (!existsSync(join(packageDir, 'payload-dist'))) {
      results.set(name, []);
      continue;
    }
    results.set(name, verifyPackage(packageDir));
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
      console.log(`      - ${name}: ${failure}`);
    }
  }

  const failedPackages = sortedNames.filter(
    (name) => results.get(name).length > 0,
  );
  console.log('');
  console.log(
    `${sortedNames.length - failedPackages.length}/${sortedNames.length} packages passed`,
  );
  // A skipped package reads as a covered one unless the count says otherwise.
  if (skipped.length > 0) {
    console.log(
      `skipped ${skipped.join(', ')}: the source of the shared libs, not a consumer of them`,
    );
  }

  if (failedPackages.length > 0) {
    console.log(`Failed: ${failedPackages.join(', ')}`);
    process.exit(1);
  }
}

main();
