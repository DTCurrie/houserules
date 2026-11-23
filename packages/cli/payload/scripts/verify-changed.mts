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
 *   (default)  print the resolved scope + the exact command per package — a plan the
 *              subagent executes, reporting one compact line per package.
 *   --json     emit the resolved scope as JSON (tests / tooling).
 *   --paths a,b  take the changed-path list from a root-relative comma list instead of
 *              git. A path outside every package (monorepo) exits 1. With
 *              verify.relatedCommand set, each changed package's `test` step runs that
 *              template instead, with {files} expanded to its selected paths.
 *   --full     plan every workspace package as full scope, with no git call. Cannot be
 *              combined with --paths (exit 1).
 *   --run      run each package's verify commands, then print "<pkg>: PASS|FAIL", plus a
 *              trimmed residue tail on failure. Exit 2 if any package failed. Each child
 *              gets the script budget's share for a run alone in WIREIT_PARALLEL and
 *              pnpm_config_workspace_concurrency. A value the caller already set, and a
 *              caller's VITEST_MAX_WORKERS, pass through unchanged.
 *
 * Config (houserules.config.json, verify block — mirrors fix): verify.runner / filterFlag /
 * runScriptPrefix / commands, verify.baseBranch (else changesets.baseBranch, else
 * "main"), verify.relatedCommand (whitespace-split template used with --paths). Per-target verifyCommands overrides commands for that package. A target
 * resolving to no verify commands is reported as skipped, never as passing.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  loadConfigSafe,
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
  vitestDefaultPool,
  type BudgetSignals,
} from '@houserules/payload/resource-budget';

/** Where the changed-path list came from. */
export type ScopeSource = 'git' | 'paths' | 'full';

export interface ScopeEntry {
  package: string;
  reason: 'changed' | 'dependent' | 'full-scope';
  single?: boolean;
  commands?: string[];
  argv?: string[][];
}

// Working-tree dirty paths + everything committed since the base branch (when it
// resolves) — the same baseline the changeset nudge uses.
function changedPaths(root: string, base: string): string[] {
  const out = new Set<string>();
  const status = git(root, ['status', '--porcelain']) ?? '';
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
    const committed =
      git(root, ['diff', '--name-only', `${base}...HEAD`]) ?? '';
    for (const p of committed.split('\n').filter(Boolean)) out.add(p);
  }
  return [...out];
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
    const deps = {
      ...p.pkg.dependencies,
      ...p.pkg.devDependencies,
      ...p.pkg.peerDependencies,
      ...p.pkg.optionalDependencies,
    };
    for (const d of Object.keys(deps))
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
): {
  scope: ScopeEntry[];
  degraded: boolean;
  selected: Map<string, string[]>;
} {
  const selected = new Map<string, string[]>();
  if (source === 'full')
    return { scope: fullScopeEntries(packages), degraded: false, selected };
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
        scope: resolveScope(paths, packages, targets),
        degraded: false,
        selected: split.byPackage,
      };
    }
    return {
      scope: resolveScope(changedPaths(root, baseBranch), packages, targets),
      degraded: false,
      selected,
    };
  } catch {
    return { scope: fullScopeEntries(packages), degraded: true, selected };
  }
}

function main() {
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

  let root: string;
  try {
    root = repoRoot();
  } catch {
    root = process.cwd();
  }

  const packages = listWorkspacePackages(root);

  const source: ScopeSource = isFullScope ? 'full' : paths ? 'paths' : 'git';
  const { scope, degraded, selected } = selectScope(
    source,
    paths,
    root,
    baseBranch,
    packages,
    targets,
  );

  for (const s of scope) {
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
  const residues = runScope(
    scope,
    root,
    runner,
    budgetShareEnv(process.env, readSignals),
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
 * cannot be read return `parentEnv` as it is.
 */
export function budgetShareEnv(
  parentEnv: NodeJS.ProcessEnv,
  readBudgetSignals: () => BudgetSignals,
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
  env.WIREIT_PARALLEL ??= String(outer);
  env.pnpm_config_workspace_concurrency ??= String(outer);
  return env;
}

/** The fields of a finished `spawnSync` result that {@link spawnTimedOut} reads. */
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

/** Runs each scope entry's commands in order, prints one PASS/FAIL line per package, and returns the failures. */
function runScope(
  scope: ScopeEntry[],
  root: string,
  runner: string,
  childEnv: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Residue[] {
  const cap =
    typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined;
  const residues: Residue[] = [];
  for (const s of scope) {
    if (!s.commands?.length) {
      process.stdout.write(`${s.package}: SKIPPED (no verify commands)\n`);
      continue;
    }
    let failedStep: string | null = null;
    let timedOut = false;
    let output = '';
    for (const [index, script] of (s.commands ?? []).entries()) {
      const r = spawnSync(runner, s.argv?.[index] ?? [], {
        cwd: root,
        env: childEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: cap,
      });
      if (r.status !== 0) {
        failedStep = script;
        output = (r.stdout || '') + (r.stderr || '');
        timedOut = spawnTimedOut(r, cap);
        break;
      }
    }
    if (failedStep) {
      const why = timedOut ? `, timed out after ${cap! / 1000}s` : '';
      process.stdout.write(`${s.package}: FAIL (${failedStep}${why})\n`);
      residues.push({ pkg: s.package, step: failedStep, output });
    } else {
      process.stdout.write(`${s.package}: PASS\n`);
    }
  }
  return residues;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    main();
  } catch {
    // A verify helper must never take down a session with its own error.
    process.exit(0);
  }
}
