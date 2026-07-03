#!/usr/bin/env node
// Stop / SubagentStop hook (claude-kit). Config-driven via .claude/kit.config.json.
//
// Runs the repo's fix commands (e.g. lint:fix, format:fix) on the packages that have
// working-tree changes, then exits 2 with stderr if anything didn't auto-fix — Claude
// sees just the residue (a trimmed tail) and resolves it, instead of running lint by
// hand and reading the full output.
//
// Safety:
// - stop_hook_active short-circuits to avoid loops
// - no changes in working tree => exit 0
// - only generated files changed => exit 0
//
// Config keys used (see kit.config.example.json):
//   targets[].pathPrefix, targets[].packageName   — map a changed path to a package
//   lintableExtensions                            — which file types trigger the hook
//   generatedFilePattern                          — files written by tooling (skip)
//   fix.runner / fix.filterFlag / fix.runScriptPrefix / fix.commands

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { loadConfigSafe } from './lib/kit-config.mjs';

// A Stop hook must never crash on a missing/broken config — it would fire on
// every stop. No config or no targets → nothing to do.
const config = loadConfigSafe();

const exts = (
  config.lintableExtensions ?? [
    'ts',
    'tsx',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'svelte',
    'md',
    'json',
    'css',
    'html',
  ]
).map((e) => e.replace(/^\./, ''));
const LINTABLE_EXT = new RegExp(`\\.(?:${exts.join('|')})$`);
const GENERATED_FILE_RE = new RegExp(
  config.generatedFilePattern ?? '/(?:CHANGELOG|BACKLOG)\\.md$',
);

const fix = config.fix ?? {};
const RUNNER = fix.runner ?? config.packageManager ?? 'pnpm';
const FILTER_FLAG = fix.filterFlag ?? '--filter'; // '' / null for a single-package repo
const RUN_PREFIX = fix.runScriptPrefix ?? []; // e.g. ['run'] for npm/yarn
const COMMANDS = fix.commands ?? ['lint:fix', 'format:fix'];

// prefix → package map (a changed file under `prefix` belongs to that package).
// targets[].fixCommands overrides the global fix.commands per package — real repos
// diverge (a wireit root exposes `fix`, packages expose `lint:fix`/`format:fix`).
const PACKAGE_BY_PATH = config.targets
  .filter((t) => t.packageName !== undefined && t.pathPrefix !== undefined)
  .map((t) => ({
    prefix: t.pathPrefix,
    name: t.packageName,
    commands: t.fixCommands ?? COMMANDS,
  }));

// Monorepo: <runner> <filterFlag> <pkg> <script>. Single-package: <runner> <runScriptPrefix...> <script>.
function fixArgs(pkg, script) {
  if (FILTER_FLAG) return [FILTER_FLAG, pkg, script];
  return [...RUN_PREFIX, script];
}

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf-8') || '{}');
  } catch {
    return {};
  }
}

function repoRootCwd() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
  });
  return r.status === 0 ? r.stdout.trim() : process.cwd();
}

function changedPaths(cwd) {
  const r = spawnSync('git', ['status', '--porcelain'], {
    encoding: 'utf-8',
    cwd,
  });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function affectedPackages(paths) {
  const pkgs = new Map();
  for (const p of paths) {
    if (!LINTABLE_EXT.test(p)) continue;
    if (GENERATED_FILE_RE.test('/' + p)) continue;
    const match = PACKAGE_BY_PATH.find((pkg) => p.startsWith(pkg.prefix));
    if (match) pkgs.set(match.name, match.commands);
  }
  return [...pkgs.entries()];
}

function runStep(pkg, script, cwd) {
  const r = spawnSync(RUNNER, fixArgs(pkg, script), {
    encoding: 'utf-8',
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: r.status === 0,
    output: (r.stdout || '') + (r.stderr || ''),
  };
}

function tail(text, lines) {
  const parts = text.split('\n');
  return parts.slice(Math.max(0, parts.length - lines)).join('\n');
}

function main() {
  const input = readInput();
  if (input.stop_hook_active) process.exit(0);

  const cwd = repoRootCwd();
  const paths = changedPaths(cwd);
  const pkgs = affectedPackages(paths);
  if (pkgs.length === 0) process.exit(0);

  const errors = [];

  for (const [pkg, commands] of pkgs) {
    for (const script of commands) {
      const r = runStep(pkg, script, cwd);
      if (!r.ok) errors.push({ pkg, step: script, output: r.output });
    }
  }

  if (errors.length > 0) {
    process.stderr.write(
      'Auto-fix left residual issues that need manual attention.\n',
    );
    process.stderr.write('Fix the items below, then return control.\n\n');
    for (const e of errors) {
      process.stderr.write(`--- ${e.pkg} :: ${e.step} ---\n`);
      process.stderr.write(tail(e.output, 60));
      process.stderr.write('\n\n');
    }
    process.exit(2);
  }

  process.exit(0);
}

main();
