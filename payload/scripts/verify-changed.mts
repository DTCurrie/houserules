#!/usr/bin/env node
// On-demand helper (claude-kit): resolve the MINIMAL verify scope for the current
// change — the packages whose files changed, PLUS every package that transitively
// DEPENDS on them — and (with --run) run each package's verify commands, emitting a
// compact PASS/FAIL-per-package verdict instead of a multi-minute full-suite
// transcript. Removes the hand-maintained "shared packages" list: dependents are
// derived from the workspace dependency graph, not memory.
//
// The /verify-changed skill runs this INSIDE a subagent so only the verdict returns
// to the main context. Degrades to full scope (every workspace package) and exit 0
// on any git/config failure — a verify helper must never block a session on its own
// error. A real verify FAILURE under --run still exits 2 (that is the point).
//
// Modes:
//   (default)  print the resolved scope + the exact command per package — a plan the
//              subagent executes, reporting one compact line per package.
//   --json     emit the resolved scope as JSON (tests / tooling).
//   --run      run each package's verify commands; print "<pkg>: PASS|FAIL" (+ a
//              trimmed residue tail on failure); exit 2 if any package failed.
//
// Config (kit.config.json, verify block — mirrors fix): verify.runner / filterFlag /
// runScriptPrefix / commands, verify.baseBranch (else changesets.baseBranch, else
// "main"); per-target verifyCommands overrides commands for that package.

import { spawnSync } from 'node:child_process';

import {
  loadConfigSafe,
  repoRoot,
  type RunnerBlock,
} from './lib/kit-config.mjs';
import {
  listWorkspacePackages,
  type WorkspacePackage,
} from './lib/workspaces.mjs';
import { git, tail } from './lib/proc.mjs';

const argv = new Set(process.argv.slice(2));
const MODE = argv.has('--run') ? 'run' : argv.has('--json') ? 'json' : 'plan';

interface ScopeEntry {
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

// Build the reverse-dependency closure: seed with the changed package names, then
// pull in every package that (transitively) lists an in-scope package as a
// dependency. This is the net-new bit — the "who else must I verify" the old
// hand-maintained shared-packages list encoded by hand.
function withDependents(
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

function main() {
  const config = loadConfigSafe();
  const verify: RunnerBlock = config.verify ?? {};
  const RUNNER = verify.runner ?? config.packageManager ?? 'pnpm';
  const FILTER_FLAG = verify.filterFlag ?? '--filter';
  const RUN_PREFIX = verify.runScriptPrefix ?? [];
  const COMMANDS = verify.commands ?? ['verify'];
  const BASE = verify.baseBranch ?? config.changesets?.baseBranch ?? 'main';

  let root: string;
  try {
    root = repoRoot();
  } catch {
    root = process.cwd();
  }

  const packages = listWorkspacePackages(root);
  const commandsFor = (name: string) =>
    (config.targets ?? []).find((t) => t.packageName === name)
      ?.verifyCommands ?? COMMANDS;
  // Monorepo: <runner> <filterFlag> <pkg> <script>. Single: <runner> <prefix...> <script>.
  const argvFor = (name: string, script: string) =>
    FILTER_FLAG ? [FILTER_FLAG, name, script] : [...RUN_PREFIX, script];

  // Resolve scope. Any failure here degrades to full scope (never blocks).
  let scope: ScopeEntry[] = [];
  let degraded = false;
  try {
    if (!packages.length) {
      // Single-package repo: the whole repo is one unit; verify it if anything
      // (non-dotfile) changed. No dependency graph to walk.
      const changed = changedPaths(root, BASE).filter(
        (p) => !p.startsWith('.'),
      );
      const rootTarget = (config.targets ?? []).find(
        (t) => t.pathPrefix === '' || t.pathPrefix === undefined,
      );
      const name = rootTarget?.packageName ?? '.';
      if (changed.length)
        scope = [{ package: name, reason: 'changed', single: true }];
    } else {
      const byPath = (config.targets ?? [])
        .filter((t) => t.pathPrefix && t.packageName && t.packageName !== '.')
        .map((t) => ({
          prefix: t.pathPrefix as string,
          name: t.packageName as string,
        }))
        // Longest prefix first so a nested target wins over its ancestor.
        .sort((a, b) => b.prefix.length - a.prefix.length);
      const changedNames = new Set<string>();
      for (const p of changedPaths(root, BASE)) {
        const hit = byPath.find((t) => p.startsWith(t.prefix));
        if (hit) changedNames.add(hit.name);
      }
      const all = withDependents(changedNames, packages);
      scope = [...all].map((name) => ({
        package: name,
        reason: changedNames.has(name)
          ? ('changed' as const)
          : ('dependent' as const),
      }));
    }
  } catch {
    degraded = true;
  }
  if (degraded) {
    scope = packages.map((p) => ({
      package: p.name,
      reason: 'full-scope' as const,
    }));
  }

  for (const s of scope) {
    s.commands = commandsFor(s.package);
    s.argv = s.commands.map((script) => argvFor(s.package, script));
  }

  if (MODE === 'json') {
    process.stdout.write(
      `${JSON.stringify({ base: BASE, degraded, runner: RUNNER, scope }, null, 2)}\n`,
    );
    process.exit(0);
  }

  if (!scope.length) {
    process.stdout.write(
      'verify-changed: no changed packages vs base — nothing to verify.\n',
    );
    process.exit(0);
  }

  if (MODE === 'plan') {
    const changed = scope.filter((s) => s.reason === 'changed').length;
    const dependents = scope.filter((s) => s.reason === 'dependent').length;
    const summary = degraded
      ? `${scope.length} package(s), FULL SCOPE (git/config unavailable)`
      : `${scope.length} package(s) in scope (${changed} changed` +
        (dependents ? ` + ${dependents} dependent` : '') +
        `) vs base \`${BASE}\``;
    const lines = [`verify-changed: ${summary}`];
    for (const s of scope)
      for (const script of s.commands ?? [])
        lines.push(
          `  ${s.package}  [${s.reason}]  ${RUNNER} ${argvFor(s.package, script).join(' ')}`,
        );
    lines.push(
      'Run each command; report one compact line per package: "<pkg>: PASS" or "<pkg>: FAIL (<step>)".',
    );
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exit(0);
  }

  // --run: execute and emit the compact verdict.
  let anyFail = false;
  const residues: { pkg: string; step: string; output: string }[] = [];
  for (const s of scope) {
    let failedStep: string | null = null;
    let output = '';
    for (const script of s.commands ?? []) {
      const r = spawnSync(RUNNER, argvFor(s.package, script), {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (r.status !== 0) {
        failedStep = script;
        output = (r.stdout || '') + (r.stderr || '');
        break;
      }
    }
    if (failedStep) {
      anyFail = true;
      process.stdout.write(`${s.package}: FAIL (${failedStep})\n`);
      residues.push({ pkg: s.package, step: failedStep, output });
    } else {
      process.stdout.write(`${s.package}: PASS\n`);
    }
  }
  for (const r of residues) {
    process.stderr.write(`\n--- ${r.pkg} :: ${r.step} ---\n`);
    process.stderr.write(`${tail(r.output, 40)}\n`);
  }
  process.exit(anyFail ? 2 : 0);
}

try {
  main();
} catch {
  // A verify helper must never take down a session with its own error.
  process.exit(0);
}
