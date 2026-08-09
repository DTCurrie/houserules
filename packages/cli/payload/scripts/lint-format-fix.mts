#!/usr/bin/env node
/**
 * Stop and SubagentStop hook. Runs the repo's fix commands on the packages with
 * working-tree changes, then exits 2 with stderr if anything did not auto-fix, so Claude
 * sees only the residue instead of running lint by hand and reading the full output.
 *
 * Exits 0 when stop_hook_active is set (which avoids loops), when the working tree is
 * clean, and when only generated files changed. SubagentStop is a no-op unless
 * fix.onSubagentStop is set: with parallel subagents each finishing worker would
 * otherwise fix every changed package concurrently, rewriting files its siblings still
 * hold open. The parent turn's Stop runs the same fix once, after the fan-out settles.
 *
 * Config keys used (see kit.config.example.json):
 *   targets[].pathPrefix, targets[].packageName   map a changed path to a package
 *   lintableExtensions                            which file types trigger the hook
 *   generatedFilePattern                          files written by tooling, skipped
 *   fix.runner / fix.filterFlag / fix.runScriptPrefix / fix.commands
 *   fix.onSubagentStop                            opt back into per-subagent fixes
 */

import { spawnSync } from 'node:child_process';

import {
  DEFAULT_FILTER_FLAG,
  loadConfigSafe,
  resolveTargetCommands,
  runsAtRepoRoot,
  type RunnerBlock,
} from './lib/kit-config.mjs';
import { readStdinJson, repoRoot, tail } from './lib/proc.mjs';

interface HookInput {
  stop_hook_active?: boolean;
  hook_event_name?: string;
}

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

const fix: RunnerBlock = config.fix ?? {};
const RUNNER = fix.runner ?? config.packageManager ?? 'pnpm';
const FILTER_FLAG = fix.filterFlag ?? DEFAULT_FILTER_FLAG; // '' / null for a single-package repo
const RUNS_AT_ROOT = runsAtRepoRoot(fix);
const RUN_PREFIX = fix.runScriptPrefix ?? []; // e.g. ['run'] for npm/yarn
const COMMANDS = fix.commands ?? ['lint:fix', 'format:fix'];
// An optional gate, off by default, running a command only when a changed file carries
// one of its extensions. It saves Stop-hook latency, not tokens.
const COMMAND_EXTENSIONS = fix.commandExtensions ?? {}; // { "lint:fix": ["ts","tsx",...] }
const gatePasses = (script: string, exts: Set<string>): boolean => {
  const allowed = COMMAND_EXTENSIONS[script];
  if (!allowed?.length) return true; // ungated → always run
  return allowed.some((e) =>
    exts.has(String(e).replace(/^\./, '').toLowerCase()),
  );
};

// targets[].fixCommands overrides the global fix.commands per package, because real
// repos diverge. A wireit root exposes `fix` while its packages expose `lint:fix`. An
// explicit null is the escape hatch: that target resolves to no commands, so a change
// confined to it runs nothing.
const PACKAGE_BY_PATH = config.targets
  .filter((t) => t.packageName !== undefined && t.pathPrefix !== undefined)
  .map((t) => ({
    prefix: t.pathPrefix as string,
    name: t.packageName as string,
    commands: resolveTargetCommands(t.fixCommands, COMMANDS),
  }));

// Monorepo: <runner> <filterFlag> <pkg> <script>. Single-package: <runner> <runScriptPrefix...> <script>.
function fixArgs(pkg: string, script: string): string[] {
  if (FILTER_FLAG) return [FILTER_FLAG, pkg, script];
  return [...RUN_PREFIX, script];
}

// Comfortably under the 600s Stop default, applied per spawnSync call so a hung git
// or fix command fails fast rather than consuming the whole event budget. SIGKILL
// because a hung formatter/linter may not respond to the default SIGTERM.
const GIT_TIMEOUT_MS = 15_000;
const FIX_TIMEOUT_MS = 120_000;

function changedPaths(cwd: string): string[] {
  const r = spawnSync('git', ['status', '--porcelain'], {
    encoding: 'utf-8',
    cwd,
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function affectedPackages(
  paths: string[],
): [name: string, commands: string[], exts: Set<string>][] {
  const pkgs = new Map<string, { commands: string[]; exts: Set<string> }>();
  for (const p of paths) {
    if (!LINTABLE_EXT.test(p)) continue;
    if (GENERATED_FILE_RE.test('/' + p)) continue;
    const match = PACKAGE_BY_PATH.find((pkg) => p.startsWith(pkg.prefix));
    if (!match) continue;
    const entry = pkgs.get(match.name) ?? {
      commands: match.commands,
      exts: new Set<string>(),
    };
    entry.exts.add((p.split('.').pop() ?? '').toLowerCase());
    pkgs.set(match.name, entry);
  }
  return [...pkgs.entries()].map(([name, v]) => [name, v.commands, v.exts]);
}

/** What the error report calls a step that ran once for the whole repo. */
const ROOT_STEP_LABEL = '(root)';

/**
 * One entry per command actually worth spawning, as [package, script, extensions].
 *
 * Per package in the filtered shape, which is what the argv encodes there. In the
 * repo-root shape the package name never reaches the argv, so N affected packages would
 * otherwise spawn the same root script N times. Those collapse to one entry per distinct
 * script, carrying the union of the changed extensions so a gated command still runs when
 * any affected package matched it.
 */
function plannedSteps(
  pkgs: [name: string, commands: string[], exts: Set<string>][],
): [pkg: string, script: string, exts: Set<string>][] {
  if (!RUNS_AT_ROOT)
    return pkgs.flatMap(([pkg, commands, exts]) =>
      commands.map((script): [string, string, Set<string>] => [
        pkg,
        script,
        exts,
      ]),
    );
  const byScript = new Map<string, Set<string>>();
  for (const [, commands, exts] of pkgs)
    for (const script of commands) {
      const union = byScript.get(script) ?? new Set<string>();
      for (const ext of exts) union.add(ext);
      byScript.set(script, union);
    }
  return [...byScript.entries()].map(([script, exts]) => [
    ROOT_STEP_LABEL,
    script,
    exts,
  ]);
}

function runStep(
  pkg: string,
  script: string,
  cwd: string,
): { ok: boolean; output: string } {
  const r = spawnSync(RUNNER, fixArgs(pkg, script), {
    encoding: 'utf-8',
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: FIX_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  const timedOut = r.signal !== null && r.status === null;
  return {
    ok: r.status === 0,
    output:
      (timedOut ? `Timed out after ${FIX_TIMEOUT_MS}ms.\n` : '') +
      (r.stdout || '') +
      (r.stderr || ''),
  };
}

function main() {
  const input = readStdinJson<HookInput>();
  if (input.stop_hook_active) process.exit(0);
  // Per-subagent fixing races itself the moment work is fanned out in parallel, and
  // buys nothing the parent's Stop doesn't: exit before spending the spawn.
  if (input.hook_event_name === 'SubagentStop' && fix.onSubagentStop !== true)
    process.exit(0);

  const cwd = repoRoot();
  const paths = changedPaths(cwd);
  const pkgs = affectedPackages(paths);
  if (pkgs.length === 0) process.exit(0);

  const errors: { pkg: string; step: string; output: string }[] = [];

  for (const [pkg, script, exts] of plannedSteps(pkgs)) {
    if (!gatePasses(script, exts)) continue; // no matching extension changed
    const r = runStep(pkg, script, cwd);
    if (!r.ok) errors.push({ pkg, step: script, output: r.output });
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
