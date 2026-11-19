#!/usr/bin/env node
/**
 * Dev-only tool, never published. Runs the built prose-lint over every payload `.mts` and
 * `.md` file, so prose that ships to user repos meets the same voice rules the repo asks of
 * them. CI has no `.claude/` tree, so the checker comes from `plugin-prose`'s `payload-dist`.
 *
 * Scope is every file under `packages/*\/payload/`: `.mts` outside any `__tests__` directory,
 * and all `.md`. `node_modules` is skipped. The walk reads the disk, not git, so a new
 * untracked file is covered.
 *
 * Usage: `node scripts/verify-payload-prose.mjs`
 *
 * Requires a prior build (`pnpm build` at the workspace root). Prints prose-lint's output and
 * exits with its status. Exits 1 if the build is missing.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { stageChecker } from './lib/stage-checker.mjs';

const repoRoot = join(import.meta.dirname, '..');
const packagesDir = join(repoRoot, 'packages');
// prose-lint's report over ~140 files is far under this. The cap only keeps spawnSync from failing with ENOBUFS on a huge one.
const MAX_CHECKER_OUTPUT_BYTES = 64 * 1024 * 1024;

// A generated copy of W3C text under a "do not edit" header, so its prose is not ours to fix.
const EXCLUDED = new Set([
  'packages/plugin-accessibility/payload/reference/wcag22.md',
]);

function walk(dir, found) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.name.endsWith('.mts') || entry.name.endsWith('.md')) {
      found.push(full);
    }
  }
}

function payloadFiles() {
  const found = [];
  for (const name of readdirSync(packagesDir).sort()) {
    const payloadDir = join(packagesDir, name, 'payload');
    if (existsSync(payloadDir)) walk(payloadDir, found);
  }
  return found
    .map((file) => relative(repoRoot, file))
    .filter((file) => !EXCLUDED.has(file))
    .sort();
}

function main() {
  const packageDir = join(packagesDir, 'plugin-prose');
  const scriptPath = join(
    packageDir,
    'payload-dist',
    'scripts',
    'prose-lint.mjs',
  );
  if (!existsSync(scriptPath)) {
    console.error(`${scriptPath} is missing. Run \`pnpm build\` first.`);
    process.exit(1);
  }

  const files = payloadFiles();
  console.error(`verify-payload-prose: scanning ${files.length} files`);

  const stagingRoot = mkdtempSync(join(tmpdir(), 'payload-prose-staging-'));
  try {
    const staged = stageChecker(
      { packageDir, scriptPath, source: readFileSync(scriptPath, 'utf8') },
      stagingRoot,
    );
    const result = spawnSync(process.execPath, [staged, ...files], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: MAX_CHECKER_OUTPUT_BYTES,
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

main();
