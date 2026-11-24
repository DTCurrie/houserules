#!/usr/bin/env node
/**
 * Resolves the minimal verify scope for the current change: the packages whose files
 * changed, plus every package that transitively depends on them. Dependents come from the
 * workspace dependency graph, not a hand-maintained list.
 *
 * Degrades to full scope and exit 0 on any git or config failure, because a verify helper
 * must never block a session on its own error. A real verify failure under --run still
 * exits 2. With verify.timeoutMs set, a step that outlives it is killed and reported as
 * "<pkg>: FAIL (<step>, timed out after <n>s)" (n = timeoutMs / 1000, e.g. 0.5 or 30).
 *
 * Modes:
 *   (default)  print the resolved scope + the exact command per package, a plan the
 *              subagent executes, reporting one compact line per package.
 *   --json     emit the resolved scope as JSON (tests / tooling).
 *   --paths a,b  take the changed-path list from a root-relative comma list instead of
 *              git. A path outside every package (monorepo) exits 1. With
 *              verify.relatedCommand set, each changed package's `test` step runs that
 *              template instead, with {files} expanded to its selected paths.
 *   --full     plan every workspace package as full scope, with no git call. Cannot be
 *              combined with --paths (exit 1).
 *   --run      run each package's verify commands, then print "<pkg>: PASS|FAIL", plus a
 *              trimmed residue tail on failure. Exit 2 if any package failed. Packages
 *              with no dependency edge between them run as concurrent jobs, up to the
 *              outer fan-out of the script budget, and a package waits for every in-scope
 *              package it depends on to exit. Verdict lines print in scope order, each
 *              once every job ahead of it has exited. Residue tails print after all jobs,
 *              in scope order. Each child gets its job's share of the budget in
 *              pnpm_config_workspace_concurrency and each variable a .claude/extensions/*.json
 *              fragment lists under shareVariables, plus VITEST_MAX_WORKERS when that share
 *              is under vitest's default pool. Jobs run one at a time when the caller
 *              already set any of those variables, which then pass through unchanged, or
 *              when the budget signals cannot be read.
 *
 * Config (houserules.config.json, verify block, mirroring fix): verify.runner / filterFlag /
 * runScriptPrefix / commands, verify.baseBranch (else changesets.baseBranch, else
 * "main"), verify.relatedCommand (whitespace-split template used with --paths),
 * verify.concurrent (false runs the --run jobs one at a time in scope order),
 * verify.rootCommands (monorepo only: workspace-root scripts appended as a final "root"
 * entry, run from the repo root with no filter flag after every package job, whenever the
 * scope holds a package or a changed path lies outside every package). Per-target
 * verifyCommands overrides commands for that package. A target resolving to no verify
 * commands is reported as skipped, never as passing.
 */

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  loadConfigSafe,
  loadExtensionsSafe,
  repoRoot,
  resolveTargetCommands,
  type ConfigTarget,
  type RunnerBlock,
} from '@houserules/payload/config';
import {
  listWorkspacePackages,
  type WorkspacePackage,
} from '@houserules/payload/workspaces';
import { git, tail } from '@houserules/payload/proc';
import {
  budgetFor,
  divideShare,
  readSignals,
  shareFor,
  vitestDefaultPool,
  type BudgetSignals,
} from '@houserules/payload/resource-budget';

/** The share variables a caller sets when this run sits inside its own budget. */
const MILLISECONDS_PER_SECOND = 1000;

const SHARE_VARIABLES = [
  'VITEST_MAX_WORKERS',
  'pnpm_config_workspace_concurrency',
] as const;

/** Where the changed-path list came from. */
export type ScopeSource = 'git' | 'paths' | 'full';

export interface ScopeEntry {
  package: string;
  reason: 'changed' | 'dependent' | 'full-scope' | 'root';
  single?: boolean;
  commands?: string[];
  argv?: string[][];
}

// Working-tree dirty paths + everything committed since the base branch, when it
// resolves. This is the same baseline the changeset nudge uses.
function changedPaths(root: string, base: string): string[] {
  const out = new Set<string>();
  const status = git(root, ['status', '--porcelain']);
  if (status === null) throw new Error('git status failed');
  for (const line of status.split('\n').filter(Boolean))
    out.add(
      line
        .slice(3)
        .trim()
        .replace(/^"|"$/g, '')
        .replace(/^.*\s->\s/, ''),
    );
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
  if (
    branch &&
    branch !== base &&
    git(root, ['rev-parse', '--verify', '--quiet', base]) !== null
  ) {
    const committed = git(root, ['diff', '--name-only', `${base}...HEAD`]);
    if (committed === null) throw new Error('git diff failed');
    for (const p of committed.split('\n').filter(Boolean)) out.add(p);
  }
  return [...out];
}

/** Every package name `p`'s manifest lists in any of its four dependency fields. */
function manifestDependencyNames(workspacePackage: WorkspacePackage): string[] {
  return Object.keys({
    ...workspacePackage.pkg.dependencies,
    ...workspacePackage.pkg.devDependencies,
    ...workspacePackage.pkg.peerDependencies,
    ...workspacePackage.pkg.optionalDependencies,
  });
}

// Seed with the changed package names, then pull in every package that transitively
// lists an in-scope one as a dependency.
export function withDependents(
  seed: Set<string>,
  packages: WorkspacePackage[],
): Set<string> {
  const names = new Set(packages.map((p) => p.name));
  const dependents = new Map<string, string[]>(
    packages.map((p) => [p.name, []]),
  );
  for (const p of packages) {
    for (const d of manifestDependencyNames(p))
      if (names.has(d) && d !== p.name) dependents.get(d)?.push(p.name);
  }
  const inScope = new Set(seed);
  const queue = [...seed];
  while (queue.length) {
    for (const dep of dependents.get(queue.shift() as string) ?? []) {
      if (!inScope.has(dep)) {
        inScope.add(dep);
        queue.push(dep);
      }
    }
  }
  return inScope;
}

/** Each package target's `pathPrefix` and name, longest prefix first so a nested target wins over its ancestor. */
function ownersByLongestPrefix(
  targets: ConfigTarget[],
): { prefix: string; name: string }[] {
  return targets
    .filter((t) => t.pathPrefix && t.packageName && t.packageName !== '.')
    .map((t) => ({
      prefix: t.pathPrefix as string,
      name: t.packageName as string,
    }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * The verify scope for `changed` paths: for a single-package repo (`packages` empty), the
 * whole repo as one entry when any non-dotfile changed. For a monorepo, every changed
 * package (longest `pathPrefix` wins on overlap) plus its transitive dependents.
 */
export function resolveScope(
  changed: string[],
  packages: WorkspacePackage[],
  targets: ConfigTarget[],
): ScopeEntry[] {
  if (!packages.length) {
    const nonDotfiles = changed.filter((p) => !p.startsWith('.'));
    const rootTarget = targets.find(
      (t) => t.pathPrefix === '' || t.pathPrefix === undefined,
    );
    const name = rootTarget?.packageName ?? '.';
    return nonDotfiles.length
      ? [{ package: name, reason: 'changed', single: true }]
      : [];
  }

  const byPath = ownersByLongestPrefix(targets);
  const changedNames = new Set<string>();
  for (const p of changed) {
    const hit = byPath.find((t) => p.startsWith(t.prefix));
    if (hit) changedNames.add(hit.name);
  }
  const all = withDependents(changedNames, packages);
  return [...all].map((name) => ({
    package: name,
    reason: changedNames.has(name)
      ? ('changed' as const)
      : ('dependent' as const),
  }));
}

/** The degraded fallback scope: every workspace package, unconditionally in scope. */
export function fullScopeEntries(packages: WorkspacePackage[]): ScopeEntry[] {
  return packages.map((p) => ({
    package: p.name,
    reason: 'full-scope' as const,
  }));
}

/** `name`'s verify commands: its target's `verifyCommands` override, else the repo default. */
export function resolveVerifyCommands(
  name: string,
  targets: ConfigTarget[],
  commands: string[] | undefined,
): string[] {
  return resolveTargetCommands(
    targets.find((t) => t.packageName === name)?.verifyCommands,
    commands,
  );
}

// Monorepo: <runner> <filterFlag> <pkg> <script>. Single-package: <runner> <runScriptPrefix...> <script>.
export function verifyArgv(
  name: string,
  script: string,
  filterFlag: string,
  runPrefix: string[],
): string[] {
  return filterFlag ? [filterFlag, name, script] : [...runPrefix, script];
}

/** The flags `verify-changed` reads. `paths` is `undefined` when `--paths` is absent. */
interface ParsedArgs {
  mode: 'run' | 'json' | 'plan';
  isFullScope: boolean;
  paths: string[] | undefined;
}

/** Parses argv (without node and script). `--paths` takes the next token as a comma list, empty entries dropped. */
function parseArgs(argv: string[]): ParsedArgs {
  const pathsAt = argv.indexOf('--paths');
  const paths =
    pathsAt === -1
      ? undefined
      : (argv[pathsAt + 1] ?? '').split(',').filter(Boolean);
  return {
    mode: argv.includes('--run')
      ? 'run'
      : argv.includes('--json')
        ? 'json'
        : 'plan',
    isFullScope: argv.includes('--full'),
    paths,
  };
}

/**
 * Splits `paths` by the target that owns each (longest `pathPrefix` wins), with the prefix
 * stripped. Paths no target owns come back in `outside`.
 */
function pathsByPackage(
  paths: string[],
  targets: ConfigTarget[],
): { byPackage: Map<string, string[]>; outside: string[] } {
  const owners = ownersByLongestPrefix(targets);
  const byPackage = new Map<string, string[]>();
  const outside: string[] = [];
  for (const p of paths) {
    const hit = owners.find((t) => p.startsWith(t.prefix));
    if (!hit) {
      outside.push(p);
      continue;
    }
    byPackage.set(hit.name, [
      ...(byPackage.get(hit.name) ?? []),
      p.slice(hit.prefix.length),
    ]);
  }
  return { byPackage, outside };
}

/**
 * The argv for a `relatedCommand` template: whitespace-split, a `{files}` token expanded to
 * `files`, or `files` appended when no token is `{files}`. A monorepo prefixes the filter
 * flag and package name.
 */
function relatedArgv(
  template: string,
  files: string[],
  name: string,
  filterFlag: string,
): string[] {
  const tokens = template.split(/\s+/).filter(Boolean);
  const expanded = tokens.includes('{files}')
    ? tokens.flatMap((t) => (t === '{files}' ? files : [t]))
    : [...tokens, ...files];
  return filterFlag ? [filterFlag, name, ...expanded] : expanded;
}

/** The `--run`-less plan output: a summary line, one command line per step, a closing note. */
export function planLines(
  scope: ScopeEntry[],
  runner: string,
  filterFlag: string,
  runPrefix: string[],
  base: string,
  degraded: boolean,
  source: ScopeSource,
): string[] {
  const changedCount = scope.filter((s) => s.reason === 'changed').length;
  const dependentCount = scope.filter((s) => s.reason === 'dependent').length;
  const summary = degraded
    ? `${scope.length} package(s), FULL SCOPE (git/config unavailable)`
    : source === 'full'
      ? `${scope.length} package(s), FULL SCOPE (--full)`
      : `${scope.length} package(s) in scope (${changedCount} changed` +
        (dependentCount ? ` + ${dependentCount} dependent` : '') +
        `) vs base \`${base}\``;
  const lines = [`verify-changed: ${summary}`];
  for (const s of scope) {
    if (!s.commands?.length)
      lines.push(`  ${s.package}  [${s.reason}]  SKIPPED (no verify commands)`);
    (s.commands ?? []).forEach((script, index) => {
      const argv =
        s.argv?.[index] ?? verifyArgv(s.package, script, filterFlag, runPrefix);
      lines.push(`  ${s.package}  [${s.reason}]  ${runner} ${argv.join(' ')}`);
    });
  }
  if (source === 'paths')
    lines.push(
      "Note: --paths selects packages, not tests. Each selected package still runs its steps package-wide, so a run can test a sibling's in-progress edit in the same package.",
    );
  lines.push(
    'Run each command; report one compact line per package: "<pkg>: PASS" or "<pkg>: FAIL (<step>)".',
  );
  return lines;
}

/** Whether `script` runs the `relatedCommand` template: the `test` step of a changed package under `--paths`, with the key set. */
function usesRelatedCommand(
  script: string,
  source: ScopeSource,
  entry: ScopeEntry,
  relatedCommand: string | undefined,
): relatedCommand is string {
  return (
    script === 'test' &&
    source === 'paths' &&
    entry.reason === 'changed' &&
    relatedCommand !== undefined
  );
}

/**
 * The root entry's key in every map keyed by `package`. No npm package name can contain `<` or
 * `>`, so a workspace package never takes it, even one named like the root `package.json`.
 */
const ROOT_ENTRY_ID = '<root>';

/** The root entry's scripts, from `verify.rootCommands`. */
interface RootEntrySpec {
  commands: string[];
}

/**
 * `scope` with the root entry appended, so repo-wide checks run after the package jobs. A
 * single-package repo or an empty `rootEntry.commands` leaves `scope` as it is, and so does a
 * scope with no package when every changed path lies inside a package.
 */
function withRootEntry(
  scope: ScopeEntry[],
  changed: string[],
  packages: WorkspacePackage[],
  targets: ConfigTarget[],
  rootEntry: RootEntrySpec,
): ScopeEntry[] {
  if (!packages.length || !rootEntry.commands.length) return scope;
  const hasOutsidePath = pathsByPackage(changed, targets).outside.length > 0;
  if (!scope.length && !hasOutsidePath) return scope;
  return [...scope, { package: ROOT_ENTRY_ID, reason: 'root' }];
}

/**
 * The scope for `source`, plus each package's `--paths` selection. A `--paths` entry outside
 * every package exits 1. Any other failure degrades to full scope, since a verify helper
 * never blocks a session on its own error.
 */
function selectScope(
  source: ScopeSource,
  paths: string[] | undefined,
  root: string,
  baseBranch: string,
  packages: WorkspacePackage[],
  targets: ConfigTarget[],
  rootEntry: RootEntrySpec,
): {
  scope: ScopeEntry[];
  degraded: boolean;
  selected: Map<string, string[]>;
} {
  const selected = new Map<string, string[]>();
  const withRoot = (scope: ScopeEntry[], changed: string[]): ScopeEntry[] =>
    withRootEntry(scope, changed, packages, targets, rootEntry);
  if (source === 'full')
    return {
      scope: withRoot(fullScopeEntries(packages), []),
      degraded: false,
      selected,
    };
  try {
    if (paths) {
      const split = pathsByPackage(paths, targets);
      if (packages.length && split.outside.length) {
        process.stderr.write(
          split.outside
            .map(
              (p) => `verify-changed: --paths ${p} is outside every package.\n`,
            )
            .join(''),
        );
        process.exit(1);
      }
      return {
        scope: withRoot(resolveScope(paths, packages, targets), paths),
        degraded: false,
        selected: split.byPackage,
      };
    }
    const changed = changedPaths(root, baseBranch);
    return {
      scope: withRoot(resolveScope(changed, packages, targets), changed),
      degraded: false,
      selected,
    };
  } catch {
    return {
      scope: withRoot(fullScopeEntries(packages), []),
      degraded: true,
      selected,
    };
  }
}

async function main() {
  const { mode, isFullScope, paths } = parseArgs(process.argv.slice(2));
  if (isFullScope && paths) {
    process.stderr.write(
      'verify-changed: --paths and --full cannot be combined.\n',
    );
    process.exit(1);
  }

  const config = loadConfigSafe();
  const verify: RunnerBlock = config.verify ?? {};
  const runner = verify.runner ?? config.packageManager ?? 'pnpm';
  const filterFlag = verify.filterFlag ?? '--filter';
  const runPrefix = verify.runScriptPrefix ?? [];
  const commands = verify.commands;
  const baseBranch =
    verify.baseBranch ?? config.changesets?.baseBranch ?? 'main';
  const targets = config.targets ?? [];

  const root = repoRoot();

  const packages = listWorkspacePackages(root);

  const rootCommands = verify.rootCommands ?? [];
  const source: ScopeSource = isFullScope ? 'full' : paths ? 'paths' : 'git';
  const { scope, degraded, selected } = selectScope(
    source,
    paths,
    root,
    baseBranch,
    packages,
    targets,
    { commands: rootCommands },
  );

  for (const s of scope) {
    if (s.reason === 'root') {
      s.commands = rootCommands;
      s.argv = rootCommands.map((script) => [...runPrefix, script]);
      continue;
    }
    s.commands = resolveVerifyCommands(s.package, targets, commands);
    s.argv = s.commands.map((script) =>
      usesRelatedCommand(script, source, s, verify.relatedCommand)
        ? relatedArgv(
            verify.relatedCommand,
            packages.length ? (selected.get(s.package) ?? []) : (paths ?? []),
            s.package,
            filterFlag,
          )
        : verifyArgv(s.package, script, filterFlag, runPrefix),
    );
  }

  if (mode === 'json') {
    process.stdout.write(
      `${JSON.stringify({ base: baseBranch, source, degraded, runner: runner, scope }, null, 2)}\n`,
    );
    process.exit(0);
  }

  if (!scope.length) {
    process.stdout.write(
      'verify-changed: no changed packages vs base — nothing to verify.\n',
    );
    process.exit(0);
  }

  if (mode === 'plan') {
    process.stdout.write(
      `${planLines(scope, runner, filterFlag, runPrefix, baseBranch, degraded, source).join('\n')}\n`,
    );
    process.exit(0);
  }

  if (mode === 'run' && commands === undefined) {
    process.stdout.write(
      'verify-changed: no "verify" block configured — add one to .claude/houserules.config.json (commands: [...]).\n',
    );
    process.exit(0);
  }

  // --run: execute and emit the compact verdict.
  const residues = await runScope(
    scope,
    jobEdges(scope, packages),
    root,
    runner,
    jobPlan(
      process.env,
      readSignals,
      verify.concurrent !== false,
      loadExtensionsSafe(root).shareVariables,
    ),
    verify.timeoutMs,
  );
  for (const r of residues) {
    process.stderr.write(`\n--- ${r.pkg} :: ${r.step} ---\n`);
    process.stderr.write(`${tail(r.output, 40)}\n`);
  }
  process.exit(residues.length > 0 ? 2 : 0);
}

/**
 * The environment for each verify child: `parentEnv` plus the share variables for a run
 * alone, whose share is the whole budget. That share never falls under vitest's default
 * pool, so `VITEST_MAX_WORKERS` is left to the caller. A variable the caller already set
 * passes through unchanged, so a run inside a wave keeps the wave's share. Signals that
 * cannot be read return `parentEnv` as it is. `toolShareVariables` are the variables the
 * installed tool fragments declare, each set to the outer fan-out like the pnpm one.
 */
export function budgetShareEnv(
  parentEnv: NodeJS.ProcessEnv,
  readBudgetSignals: () => BudgetSignals,
  toolShareVariables: string[],
): NodeJS.ProcessEnv {
  let signals: BudgetSignals;
  try {
    signals = readBudgetSignals();
  } catch {
    return parentEnv;
  }
  const share = budgetFor({ ncpu: signals.ncpu, load1: signals.load1 });
  const { outer } = divideShare(share, vitestDefaultPool(signals.ncpu));
  const env = { ...parentEnv };
  for (const name of toolShareVariables) env[name] ??= String(outer);
  env.pnpm_config_workspace_concurrency ??= String(outer);
  return env;
}

/** How many verify jobs may run at once, and the environment every job's children get. */
interface JobPlan {
  limit: number;
  childEnv: NodeJS.ProcessEnv;
}

/**
 * The job limit and child environment for `--run`, from signals read once. Concurrent, the
 * limit is the outer fan-out of the run-alone share, and each child gets `shareFor(budget,
 * limit)` divided the same way. That share never falls under vitest's default pool at the
 * computed limit, so `VITEST_MAX_WORKERS` is left to the caller. The plan falls back to one job with
 * {@link budgetShareEnv}'s environment when `isConcurrent` is false or the caller set any
 * share variable, since the run then sits inside someone else's budget. Signals that cannot
 * be read give one job and `parentEnv` as it is.
 */
export function jobPlan(
  parentEnv: NodeJS.ProcessEnv,
  readBudgetSignals: () => BudgetSignals,
  isConcurrent: boolean,
  toolShareVariables: string[],
): JobPlan {
  let signals: BudgetSignals;
  try {
    signals = readBudgetSignals();
  } catch {
    return { limit: 1, childEnv: parentEnv };
  }
  const isInsideCallerBudget = [...SHARE_VARIABLES, ...toolShareVariables].some(
    (name) => parentEnv[name] !== undefined,
  );
  if (!isConcurrent || isInsideCallerBudget)
    return {
      limit: 1,
      childEnv: budgetShareEnv(parentEnv, () => signals, toolShareVariables),
    };
  const budget = budgetFor({ ncpu: signals.ncpu, load1: signals.load1 });
  const pool = vitestDefaultPool(signals.ncpu);
  const limit = divideShare(budget, pool).outer;
  const { outer } = divideShare(shareFor(budget, limit), pool);
  const childEnv: NodeJS.ProcessEnv = {
    ...parentEnv,
    pnpm_config_workspace_concurrency: String(outer),
  };
  for (const name of toolShareVariables) childEnv[name] = String(outer);
  return { limit, childEnv };
}

/**
 * Each scope entry's in-scope dependencies: the other scope packages its manifest lists in
 * any dependency field. An entry with no workspace manifest, such as a single-package
 * repo's, has none.
 */
export function jobEdges(
  scope: ScopeEntry[],
  packages: WorkspacePackage[],
): Map<string, string[]> {
  const inScope = new Set(scope.map((s) => s.package));
  const byName = new Map(packages.map((p) => [p.name, p]));
  return new Map(
    scope.map((s) => {
      if (s.reason === 'root')
        return [
          s.package,
          scope.filter((other) => other !== s).map((other) => other.package),
        ];
      const manifest = byName.get(s.package);
      const deps = manifest
        ? manifestDependencyNames(manifest).filter(
            (d) => d !== s.package && inScope.has(d),
          )
        : [];
      return [s.package, deps];
    }),
  );
}

/**
 * The next job to start from `pending`, which is in scope order: the first whose every
 * in-scope dependency has exited. When none is ready and `runningCount` is 0, the first
 * pending job, so a dependency cycle never deadlocks the run. `undefined` means wait for a
 * running job to exit.
 */
export function nextJob(
  pending: string[],
  edges: Map<string, string[]>,
  exited: Set<string>,
  runningCount: number,
): string | undefined {
  const ready = pending.find((name) =>
    (edges.get(name) ?? []).every((dep) => exited.has(dep)),
  );
  if (ready !== undefined) return ready;
  return runningCount === 0 ? pending[0] : undefined;
}

/**
 * The fields of a finished step that {@link spawnTimedOut} reads. A step the cap killed
 * carries an `ETIMEDOUT` error and its signal, the same shape `spawnSync` gives.
 */
export interface FinishedSpawn {
  error?: Error;
  signal: NodeJS.Signals | null;
}

/**
 * Whether a failed step ended because `cap` killed it. An uncapped step is never timed
 * out, since nothing here sent the signal.
 */
export function spawnTimedOut(
  result: FinishedSpawn,
  cap: number | undefined,
): boolean {
  return (
    cap !== undefined &&
    ((result.error as NodeJS.ErrnoException | undefined)?.code ===
      'ETIMEDOUT' ||
      result.signal !== null)
  );
}

interface Residue {
  pkg: string;
  step: string;
  output: string;
}

interface StepResult extends FinishedSpawn {
  status: number | null;
  output: string;
}

/**
 * Runs one step as a child and resolves once it closes, never rejecting. With `cap` set, a
 * step still running after `cap` ms is sent SIGTERM and resolves with an `ETIMEDOUT` error.
 * `output` is the step's stdout followed by its stderr.
 */
function runStep(
  runner: string,
  argv: string[],
  root: string,
  env: NodeJS.ProcessEnv,
  cap: number | undefined,
): Promise<StepResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let error: Error | undefined;
    let isSettled = false;
    const child = spawn(runner, argv, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer =
      cap === undefined
        ? undefined
        : setTimeout(() => {
            error = Object.assign(new Error(`spawn ${runner} ETIMEDOUT`), {
              code: 'ETIMEDOUT',
            });
            child.kill('SIGTERM');
          }, cap);
    const finish = (
      status: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      resolve({
        status,
        signal,
        ...(error && { error }),
        output:
          Buffer.concat(stdout).toString('utf8') +
          Buffer.concat(stderr).toString('utf8'),
      });
    };
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (spawnError) => {
      error ??= spawnError;
      finish(null, null);
    });
    child.on('close', finish);
  });
}

/** One finished job: its verdict line, and the residue when it failed. */
interface JobResult {
  verdict: string;
  residue?: Residue;
}

/** Runs `entry`'s steps in order, stopping at the first failure. */
async function runJob(
  entry: ScopeEntry,
  root: string,
  runner: string,
  childEnv: NodeJS.ProcessEnv,
  cap: number | undefined,
): Promise<JobResult> {
  if (!entry.commands?.length)
    return { verdict: `${entry.package}: SKIPPED (no verify commands)` };
  for (const [index, script] of entry.commands.entries()) {
    const stepResult = await runStep(
      runner,
      entry.argv?.[index] ?? [],
      root,
      childEnv,
      cap,
    );
    if (stepResult.status === 0) continue;
    const why = spawnTimedOut(stepResult, cap)
      ? `, timed out after ${(cap ?? 0) / MILLISECONDS_PER_SECOND}s`
      : '';
    return {
      verdict: `${entry.package}: FAIL (${script}${why})`,
      residue: { pkg: entry.package, step: script, output: stepResult.output },
    };
  }
  return { verdict: `${entry.package}: PASS` };
}

/**
 * Runs the scope as jobs, up to `plan.limit` at once, each starting once every in-scope
 * dependency's job has exited. Prints one verdict line per package in scope order, each
 * once every job ahead of it has exited, and returns the failures in scope order.
 */
async function runScope(
  scope: ScopeEntry[],
  edges: Map<string, string[]>,
  root: string,
  runner: string,
  plan: JobPlan,
  timeoutMs?: number,
): Promise<Residue[]> {
  const cap =
    typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined;
  const byName = new Map(scope.map((s) => [s.package, s]));
  const pending = scope.map((s) => s.package);
  const exited = new Set<string>();
  const results = new Map<string, JobResult>();
  let runningCount = 0;
  let printedCount = 0;
  await new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      for (;;) {
        const head = scope[printedCount];
        const result = head && results.get(head.package);
        if (!result) break;
        process.stdout.write(`${result.verdict}\n`);
        printedCount++;
      }
      if (printedCount === scope.length) {
        resolve();
        return;
      }
      while (runningCount < plan.limit) {
        const name = nextJob(pending, edges, exited, runningCount);
        const entry = name === undefined ? undefined : byName.get(name);
        if (name === undefined || !entry) return;
        pending.splice(pending.indexOf(name), 1);
        runningCount++;
        runJob(entry, root, runner, plan.childEnv, cap).then((done) => {
          runningCount--;
          exited.add(name);
          results.set(name, done);
          pump();
        }, reject);
      }
    };
    pump();
  });
  return scope.flatMap((s) => results.get(s.package)?.residue ?? []);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  // A verify helper must never take down a session with its own error.
  main().catch(() => process.exit(0));
}
