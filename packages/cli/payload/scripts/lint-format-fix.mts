#!/usr/bin/env node
/**
 * Stop and SubagentStop hook. Runs the repo's fix commands on the packages whose files the
 * ended turn modified, then exits 2 with stderr if anything did not auto-fix, so Claude
 * sees only the residue instead of running lint by hand and reading the full output.
 *
 * A working-tree change belongs to the turn when its file was modified at or after the
 * prompt that opened it, so edits the user or an earlier turn left uncommitted are never
 * fixed. With no transcript to read that prompt from, every working-tree change counts.
 *
 * Exits 0 when stop_hook_active is set (which avoids loops), when the working tree is
 * clean, and when only generated files changed. It also exits 0 before spawning anything
 * when the Stop payload's background_tasks is non-empty, since the tree is still moving.
 * It exits 0 the same way when the transcript shows the ended turn used only read-only
 * tools, and an unreadable transcript falls through to the normal run. A fix step that
 * overruns the whole-hook budget ends the hook with exit 0 and one stderr line naming the
 * step and the budget, instead of the harness killing the hook mid-report. SubagentStop is a no-op unless
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
 *   fix.passPaths                                 append `-- <the turn's changed paths>` to each step
 *
 * With fix.passPaths off the hook runs nothing and exits 0, since a whole-tree fix outlasts a
 * Stop. With it on, a step whose path list outgrows the command-line budget is skipped with
 * one stderr line, and the hook goes on to the next step.
 *
 * A step whose script the target's package.json does not define is skipped with one stderr
 * notice, and the hook still exits 0.
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_FILTER_FLAG,
  loadConfigSafe,
  resolveTargetCommands,
  runsAtRepoRoot,
  type HouseConfig,
} from '@houserules/payload/config';
import { readStdinJson, repoRoot, tail } from '@houserules/payload/proc';
import {
  turnStartedAt,
  turnTouchedFiles,
} from '@houserules/payload/transcript-turn';

interface HookInput {
  stop_hook_active?: boolean;
  hook_event_name?: string;
  transcript_path?: string;
  background_tasks?: unknown[];
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
  passPaths: boolean;
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
    passPaths: fix.passPaths === true,
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

/** A planned fix step. `paths` is set only when `fix.passPaths` is on. */
export type FixStep = [pkg: string, script: string, paths?: string[]];

/**
 * The changed paths one step should be handed, as the runner will see them: package-relative
 * in the filtered shape, root-relative in the root shape, narrowed to the step's own
 * `commandExtensions` when it has any.
 */
function pathsForStep(
  pkg: string,
  script: string,
  paths: string[],
  settings: FixSettings,
): string[] {
  const allowed = settings.commandExtensions[script]?.map((extension) =>
    String(extension).replace(/^\./, '').toLowerCase(),
  );
  const out: string[] = [];
  for (const path of paths) {
    if (!settings.lintableExtRe.test(path)) continue;
    if (settings.generatedFileRe.test('/' + path)) continue;
    const match = settings.packageByPath.find((target) =>
      path.startsWith(target.prefix),
    );
    if (!match || !stepOwnsPackage(match, pkg, script, settings)) continue;
    const extension = (path.split('.').pop() ?? '').toLowerCase();
    if (allowed?.length && !allowed.includes(extension)) continue;
    out.push(settings.runsAtRoot ? path : path.slice(match.prefix.length));
  }
  return out;
}

/**
 * Whether a step covers a path in `match`'s package: in the root shape, when the package
 * carries the step's script, otherwise when the step runs in that package.
 */
function stepOwnsPackage(
  match: FixSettings['packageByPath'][number],
  pkg: string,
  script: string,
  settings: FixSettings,
): boolean {
  return settings.runsAtRoot
    ? match.commands.includes(script)
    : match.name === pkg;
}

/**
 * The fully resolved list of steps to run for `paths`, given `settings`: lintable and
 * non-generated files mapped to their package's commands, root-level commands collapsed, and
 * each step's extension gate applied. With `fix.passPaths` on, each step also carries the
 * paths it should be scoped to.
 */
export function planFixSteps(
  paths: string[],
  settings: FixSettings,
): FixStep[] {
  const pkgs = affectedPackages(paths, settings);
  const steps = plannedSteps(pkgs, settings.runsAtRoot);
  return steps
    .filter(([, script, exts]) =>
      gatePasses(script, exts, settings.commandExtensions),
    )
    .map(([pkg, script]): FixStep =>
      settings.passPaths
        ? [pkg, script, pathsForStep(pkg, script, paths, settings)]
        : [pkg, script],
    );
}

/**
 * Bytes of path arguments a step may carry. Windows caps a command line near 32,000
 * characters, the tightest limit among the platforms this runs on, so this stays under it.
 */
export const ARGV_PATH_BYTE_BUDGET = 30_000;

/** The separator each path argument adds to the command line. */
const ARGV_SEPARATOR_BYTES = 1;

// Monorepo: <runner> <filterFlag> <pkg> <script>. Single-package: <runner> <runScriptPrefix...> <script>.
export function fixArgs(
  pkg: string,
  script: string,
  filterFlag: string,
  runPrefix: string[],
  paths: string[],
): string[] {
  const base = filterFlag ? [filterFlag, pkg, script] : [...runPrefix, script];
  return paths.length > 0 ? [...base, '--', ...paths] : base;
}

/**
 * The scoped argv for one step, or `null` when its path list outgrows
 * {@link ARGV_PATH_BYTE_BUDGET} and the step has to be skipped.
 */
export function stepArgv(
  [pkg, script, paths = []]: FixStep,
  settings: FixSettings,
): string[] | null {
  const bytes = paths.reduce(
    (sum, path) => sum + Buffer.byteLength(path) + ARGV_SEPARATOR_BYTES,
    0,
  );
  if (bytes > ARGV_PATH_BYTE_BUDGET) return null;
  return fixArgs(pkg, script, settings.filterFlag, settings.runPrefix, paths);
}

/** `paths` whose file still exists, so a path deleted during the turn is never passed. */
export function existingPaths(paths: string[], cwd: string): string[] {
  return paths.filter((path) => {
    try {
      statSync(join(cwd, path));
      return true;
    } catch {
      return false;
    }
  });
}

/** The scripts of the `package.json` at `file`, or null when it cannot be read. */
function readScripts(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    const scripts = (parsed as { scripts?: unknown } | null)?.scripts;
    return scripts && typeof scripts === 'object'
      ? (scripts as Record<string, unknown>)
      : {};
  } catch {
    return null;
  }
}

/**
 * Splits `steps` into those whose script the step's `package.json` defines and one notice
 * per skipped step. The package dir in the filtered shape, the root in the root shape. A
 * `package.json` that cannot be read skips nothing, since absence there proves nothing.
 */
export function skipMissingScripts(
  steps: FixStep[],
  cwd: string,
  settings: FixSettings,
): { steps: FixStep[]; notices: string[] } {
  const kept: FixStep[] = [];
  const notices: string[] = [];
  for (const step of steps) {
    const [pkg, script] = step;
    const prefix = settings.runsAtRoot
      ? ''
      : (settings.packageByPath.find((t) => t.name === pkg)?.prefix ?? '');
    const file = join(cwd, prefix, 'package.json');
    const scripts = readScripts(file);
    if (scripts && !(script in scripts)) {
      notices.push(
        `lint-format-fix: skipped "${script}", no such script in ${join(prefix, 'package.json')}.\n`,
      );
      continue;
    }
    kept.push(step);
  }
  return { steps: kept, notices };
}

// Applied to the git spawnSync call so a hung git fails fast. SIGKILL because a hung
// process may not respond to the default SIGTERM.
const GIT_TIMEOUT_MS = 15_000;

/**
 * Total milliseconds the script may spend in fix spawns. The lint-fix module wires the hook
 * with a 120s timeout, and a spawn that runs to that limit is killed by the harness before
 * it can report. This plus the git spawn stays under it, so the script ends the hook itself.
 */
export const FIX_BUDGET_MS = 90_000;

/** The paths `git status --porcelain` lists, with a rename reduced to its new path. */
export function pathsFromPorcelain(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) =>
      line
        .slice(3)
        .trim()
        .replace(/^.* -> /, ''),
    )
    .filter(Boolean);
}

/**
 * Every changed path, with `--untracked-files=all` so a file in a directory git has never seen
 * lists on its own line instead of collapsing into one extensionless directory entry.
 */
function changedPaths(cwd: string): string[] {
  const r = spawnSync(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    {
      encoding: 'utf-8',
      cwd,
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    },
  );
  if (r.status !== 0 || !r.stdout) return [];
  return pathsFromPorcelain(r.stdout);
}

/**
 * The `paths`, relative to `cwd`, whose file was modified at or after `sinceMs`. A path
 * that cannot be stat'd, such as a deletion, is dropped, since there is nothing to fix.
 */
export function modifiedSince(
  paths: string[],
  cwd: string,
  sinceMs: number,
): string[] {
  return paths.filter((path) => {
    try {
      return statSync(join(cwd, path)).mtimeMs >= sinceMs;
    } catch {
      return false;
    }
  });
}

/** The fields of a finished step's exit that {@link stepTimedOut} reads. */
export interface FinishedSpawn {
  status: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Whether a fix step was killed rather than exiting. Every step runs under a timeout, so a
 * signal with no exit status is the timeout's kill.
 */
export function stepTimedOut(result: FinishedSpawn): boolean {
  return result.signal !== null && result.status === null;
}

/**
 * SIGKILLs the process group led by `pid`. Killing only the direct child leaves any
 * grandchild alive and holding the step's stdout open. A group already gone (ESRCH) is
 * not an error, since the hook must exit 0 on every failure path.
 */
export function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group already exited.
  }
}

interface StepResult {
  ok: boolean;
  timedOut: boolean;
  output: string;
}

/**
 * Runs one fix step as the leader of its own process group. When `timeoutMs` runs out the
 * whole group is killed and the pipes are dropped at once, so a grandchild still holding
 * stdout cannot keep the hook waiting.
 */
function runStep(
  argv: string[],
  cwd: string,
  settings: FixSettings,
  timeoutMs: number,
): Promise<StepResult> {
  return new Promise((resolve) => {
    let output = '';
    let isSettled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(settings.runner, argv, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      resolve({ ok: false, timedOut: false, output: String(err) });
      return;
    }

    const timer = setTimeout(() => {
      killGroup(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ ok: false, timedOut: true, output });
    }, timeoutMs);
    const finish = (result: StepResult): void => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      resolve(result);
    };

    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf-8');
      stream?.on('data', (chunk: string) => {
        output += chunk;
      });
      // A pipe destroyed at the kill may still emit an error, which must not crash the hook.
      stream?.on('error', () => {});
    }
    child.on('error', (err) =>
      finish({ ok: false, timedOut: false, output: output + String(err) }),
    );
    child.on('close', (status, signal) =>
      finish({
        ok: status === 0,
        timedOut: stepTimedOut({ status, signal }),
        output,
      }),
    );
  });
}

/** The step that ran out the fix budget. */
export interface BudgetOverrun {
  pkg: string;
  step: string;
}

/** What {@link runFixSteps} observed: residue from finished steps, and the overrun if one ended the run. */
export interface FixRun {
  errors: { pkg: string; step: string; output: string }[];
  overrun: BudgetOverrun | null;
}

/** The single stderr line written when `overrun` ended the run. */
export function overrunNotice(
  overrun: BudgetOverrun,
  budgetMs: number,
): string {
  return `lint-format-fix: ${overrun.pkg} :: ${overrun.step} did not finish within the ${budgetMs}ms fix budget, skipping the remaining steps.\n`;
}

/**
 * Runs `steps` in order, each with whatever remains of `budgetMs` as its timeout. A step
 * that times out, or that starts with nothing left, ends the run and is reported as the
 * overrun. Failures from steps that did finish stay in `errors`.
 */
export async function runFixSteps(
  steps: FixStep[],
  cwd: string,
  settings: FixSettings,
  budgetMs: number,
  now: () => number = Date.now,
): Promise<FixRun> {
  const startedAt = now();
  const errors: FixRun['errors'] = [];
  for (const step of steps) {
    const [pkg, script] = step;
    const remaining = budgetMs - (now() - startedAt);
    if (remaining <= 0) return { errors, overrun: { pkg, step: script } };
    const argv = stepArgv(step, settings);
    if (argv === null) {
      process.stderr.write(
        `lint-format-fix: ${script} for ${pkg} had too many changed paths for one command line, so it was skipped.\n`,
      );
      continue;
    }
    const r = await runStep(argv, cwd, settings, remaining);
    if (r.timedOut) return { errors, overrun: { pkg, step: script } };
    if (!r.ok) errors.push({ pkg, step: script, output: r.output });
  }
  return { errors, overrun: null };
}

async function main(): Promise<void> {
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
  // A whole-tree fix outlasts a Stop, so with passPaths off there is nothing to run.
  if (!settings.passPaths) process.exit(0);
  if (
    Array.isArray(input.background_tasks) &&
    input.background_tasks.length > 0
  )
    process.exit(0);
  if (turnTouchedFiles(input.transcript_path) === false) process.exit(0);

  const cwd = root;
  const startedAt = turnStartedAt(input.transcript_path);
  const changed = changedPaths(cwd);
  const paths =
    startedAt === undefined ? changed : modifiedSince(changed, cwd, startedAt);
  const planned = planFixSteps(existingPaths(paths, cwd), settings);
  const { steps, notices } = skipMissingScripts(planned, cwd, settings);
  for (const notice of notices) process.stderr.write(notice);
  if (steps.length === 0) process.exit(0);

  const { errors, overrun } = await runFixSteps(
    steps,
    cwd,
    settings,
    FIX_BUDGET_MS,
  );
  if (overrun) process.stderr.write(overrunNotice(overrun, FIX_BUDGET_MS));

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
  void main();
}
