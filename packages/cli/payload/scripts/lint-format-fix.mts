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
 * Config keys used (see houserules.config.example.json):
 *   targets[].pathPrefix, targets[].packageName   map a changed path to a package
 *   lintableExtensions                            which file types trigger the hook
 *   generatedFilePattern                          files written by tooling, skipped
 *   fix.runner / fix.filterFlag / fix.runScriptPrefix / fix.commands
 *   fix.onSubagentStop                            opt back into per-subagent fixes
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_FILTER_FLAG,
  loadConfigSafe,
  resolveTargetCommands,
  runsAtRepoRoot,
  type HouseConfig,
} from '@houserules/payload/config';
import { readStdinJson, repoRoot, tail } from '@houserules/payload/proc';

interface HookInput {
  stop_hook_active?: boolean;
  hook_event_name?: string;
}

/** Everything {@link planFixSteps} needs, resolved once from a loaded `HouseConfig`. */
export interface FixSettings {
  lintableExtRe: RegExp;
  generatedFileRe: RegExp;
  runner: string;
  filterFlag: string;
  runsAtRoot: boolean;
  runPrefix: string[];
  commandExtensions: Record<string, string[]>;
  onSubagentStop: boolean;
  packageByPath: { prefix: string; name: string; commands: string[] }[];
}

/**
 * Resolves the repo-specific settings a `houserules.config.json`'s `fix` block and
 * `targets` describe, defaulting every field so a missing or partial config still runs.
 */
export function resolveFixSettings(config: HouseConfig): FixSettings {
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
  const lintableExtRe = new RegExp(`\\.(?:${exts.join('|')})$`);
  const generatedFileRe = new RegExp(
    config.generatedFilePattern ?? '/(?:CHANGELOG|BACKLOG)\\.md$',
  );

  const fix = config.fix ?? {};
  const runner = fix.runner ?? config.packageManager ?? 'pnpm';
  const filterFlag = fix.filterFlag ?? DEFAULT_FILTER_FLAG; // '' / null for a single-package repo
  const runsAtRoot = runsAtRepoRoot(fix);
  const runPrefix = fix.runScriptPrefix ?? []; // e.g. ['run'] for npm/yarn
  const commands = fix.commands ?? ['lint:fix', 'format:fix'];
  // An optional gate, off by default, running a command only when a changed file carries
  // one of its extensions. It saves Stop-hook latency, not tokens.
  const commandExtensions = fix.commandExtensions ?? {}; // { "lint:fix": ["ts","tsx",...] }

  // targets[].fixCommands overrides the global fix.commands per package, because real
  // repos diverge. A wireit root exposes `fix` while its packages expose `lint:fix`. An
  // explicit null is the escape hatch: that target resolves to no commands, so a change
  // confined to it runs nothing.
  const packageByPath = config.targets
    .filter((t) => t.packageName !== undefined && t.pathPrefix !== undefined)
    .map((t) => ({
      prefix: t.pathPrefix as string,
      name: t.packageName as string,
      commands: resolveTargetCommands(t.fixCommands, commands),
    }));

  return {
    lintableExtRe,
    generatedFileRe,
    runner,
    filterFlag,
    runsAtRoot,
    runPrefix,
    commandExtensions,
    onSubagentStop: fix.onSubagentStop === true,
    packageByPath,
  };
}

/** Whether `script` should run given the extensions actually changed, under its own gate. */
export function gatePasses(
  script: string,
  changedExts: Set<string>,
  commandExtensions: Record<string, string[]>,
): boolean {
  const allowed = commandExtensions[script];
  if (!allowed?.length) return true; // ungated → always run
  return allowed.some((e) =>
    changedExts.has(String(e).replace(/^\./, '').toLowerCase()),
  );
}

/** Maps `paths` to the package each belongs to, skipping non-lintable and generated files. */
export function affectedPackages(
  paths: string[],
  settings: FixSettings,
): [name: string, commands: string[], exts: Set<string>][] {
  const pkgs = new Map<string, { commands: string[]; exts: Set<string> }>();
  for (const p of paths) {
    if (!settings.lintableExtRe.test(p)) continue;
    if (settings.generatedFileRe.test('/' + p)) continue;
    const match = settings.packageByPath.find((pkg) =>
      p.startsWith(pkg.prefix),
    );
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
export function plannedSteps(
  pkgs: [name: string, commands: string[], exts: Set<string>][],
  runsAtRoot: boolean,
): [pkg: string, script: string, exts: Set<string>][] {
  if (!runsAtRoot)
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

/**
 * The fully resolved list of `[pkg, script]` steps to run for `paths`, given `settings`:
 * lintable and non-generated files mapped to their package's commands, root-level commands
 * collapsed, and each step's extension gate applied.
 */
export function planFixSteps(
  paths: string[],
  settings: FixSettings,
): [pkg: string, script: string][] {
  const pkgs = affectedPackages(paths, settings);
  const steps = plannedSteps(pkgs, settings.runsAtRoot);
  return steps
    .filter(([, script, exts]) =>
      gatePasses(script, exts, settings.commandExtensions),
    )
    .map(([pkg, script]) => [pkg, script]);
}

// Monorepo: <runner> <filterFlag> <pkg> <script>. Single-package: <runner> <runScriptPrefix...> <script>.
export function fixArgs(
  pkg: string,
  script: string,
  filterFlag: string,
  runPrefix: string[],
): string[] {
  if (filterFlag) return [filterFlag, pkg, script];
  return [...runPrefix, script];
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

function runStep(
  pkg: string,
  script: string,
  cwd: string,
  settings: FixSettings,
): { ok: boolean; output: string } {
  const r = spawnSync(
    settings.runner,
    fixArgs(pkg, script, settings.filterFlag, settings.runPrefix),
    {
      encoding: 'utf-8',
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: FIX_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    },
  );
  const timedOut = r.signal !== null && r.status === null;
  return {
    ok: r.status === 0,
    output:
      (timedOut ? `Timed out after ${FIX_TIMEOUT_MS}ms.\n` : '') +
      (r.stdout || '') +
      (r.stderr || ''),
  };
}

function main(): void {
  // Resolved before the config load so the root is passed in rather than spawned twice.
  // `repoRoot()` falls back to the cwd instead of throwing, so this is safe here.
  const root = repoRoot();
  // A Stop hook must never crash on a missing/broken config — it would fire on
  // every stop. No config or no targets → nothing to do.
  const config = loadConfigSafe(root);
  const settings = resolveFixSettings(config);

  const input = readStdinJson<HookInput>();
  if (input.stop_hook_active) process.exit(0);
  // Per-subagent fixing races itself the moment work is fanned out in parallel, and
  // buys nothing the parent's Stop doesn't: exit before spending the spawn.
  if (input.hook_event_name === 'SubagentStop' && !settings.onSubagentStop)
    process.exit(0);

  const cwd = root;
  const paths = changedPaths(cwd);
  const steps = planFixSteps(paths, settings);
  if (steps.length === 0) process.exit(0);

  const errors: { pkg: string; step: string; output: string }[] = [];

  for (const [pkg, script] of steps) {
    const r = runStep(pkg, script, cwd, settings);
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
