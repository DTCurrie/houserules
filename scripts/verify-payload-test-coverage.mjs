#!/usr/bin/env node
/**
 * Dev-only tool, never published. Asserts that every package shipping payload scripts is
 * configured to both TYPECHECK and RUN tests placed beside that payload code, which is where
 * `testing.md` says they belong.
 *
 * Two configs have to agree, and each one alone produces a green signal over work that did not
 * happen. `tsconfig.json`'s `include` decides whether `pnpm check` reads a payload test.
 * `vitest.config.ts`'s `include` decides whether `pnpm test` runs it. A package missing the first
 * typechecks nothing under `payload/**\/__test__/`. A package missing the second never executes
 * those suites at all, and reports success while doing it.
 *
 * What this proves: the globs are present. What it does not prove: that any given test is
 * correct, or that a package has any payload tests to begin with. The gap it guards is latent by
 * nature, since it only bites the moment someone adds a test in the right place.
 *
 * Usage: `node scripts/verify-payload-test-coverage.mjs`
 *
 * Exits 1 if any package that ships payload scripts is missing either glob.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const packagesDir = join(repoRoot, 'packages');

const TSCONFIG_GLOB = 'payload/**/__test__/**/*.ts';
const VITEST_GLOB = 'payload/**/__test__/**/*.test.ts';

/** Every `.mts` under a package's `payload/scripts/`, which is what makes the globs load-bearing. */
function payloadScriptCount(packageDir) {
  const scriptsDir = join(packageDir, 'payload', 'scripts');
  if (!existsSync(scriptsDir)) return 0;

  let count = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== '__test__') walk(full);
      } else if (entry.endsWith('.mts')) {
        count += 1;
      }
    }
  };
  walk(scriptsDir);
  return count;
}

function problemsFor(packageDir) {
  const problems = [];

  const tsconfigPath = join(packageDir, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    problems.push('no tsconfig.json, so `check` reads nothing');
  } else if (!readFileSync(tsconfigPath, 'utf8').includes(TSCONFIG_GLOB)) {
    problems.push(
      `tsconfig.json "include" is missing "${TSCONFIG_GLOB}", so payload tests are never typechecked`,
    );
  }

  const vitestPath = join(packageDir, 'vitest.config.ts');
  if (!existsSync(vitestPath)) {
    problems.push('no vitest.config.ts, so payload tests are never run');
  } else if (!readFileSync(vitestPath, 'utf8').includes(VITEST_GLOB)) {
    problems.push(
      `vitest.config.ts "include" is missing "${VITEST_GLOB}", so payload tests are never run`,
    );
  }

  return problems;
}

function main() {
  const results = new Map();

  for (const name of readdirSync(packagesDir).sort()) {
    const packageDir = join(packagesDir, name);
    if (!statSync(packageDir).isDirectory()) continue;
    if (payloadScriptCount(packageDir) === 0) continue;

    results.set(name, problemsFor(packageDir));
  }

  const failed = [];
  for (const [name, problems] of results) {
    if (problems.length === 0) {
      console.log(`  ok   ${name}`);
      continue;
    }
    failed.push(name);
    console.log(`  FAIL ${name}`);
    for (const problem of problems) console.log(`         ${problem}`);
  }

  console.log('');
  console.log(
    `${results.size - failed.length}/${results.size} payload-shipping packages cover their payload tests`,
  );

  if (failed.length > 0) {
    console.log(`Failed: ${failed.join(', ')}`);
    process.exit(1);
  }
}

main();
