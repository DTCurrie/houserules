import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  resolveTargetCommands,
  runsAtRepoRoot,
} from '@agent-kit/payload/kit-config';
import { listWorkspacePackages, readJson } from '@agent-kit/payload/workspaces';
import { validateKitConfig } from '../../core/config.js';
import type { KitConfig } from '../../core/config.js';
import type { Ctx } from '../../detect.js';
import { MODULES } from '../../plan.js';
import { PluginResolutionError, type Registry } from '../../plugin-registry.js';
import { buildRegistry } from '../../plugin-resolver.js';
import type { CheckResult, Finding } from './finding.js';

export interface ConfigValidity extends CheckResult {
  /**
   * Schema rejections, kept apart from the findings so the exit code can distinguish
   * "your config is not valid" (2) from "your install has a problem" (1). A non-empty
   * list means the reality checks below it did not run.
   */
  configProblems: string[];
  /**
   * The registry built while proving the declared plugins load. Returned so the rest of the
   * run reuses it instead of resolving every plugin a second time. Null whenever this check
   * stopped early, which is also every case where `configProblems` is non-empty.
   */
  registry: Registry | null;
}

/**
 * Per-target checks: pathPrefix/sourcePath/package existence, and named fix/verify
 * scripts against that target's own `package.json`. Root-run commands are collected
 * rather than checked here, since the repo-root shape checks them once against the root
 * `package.json` regardless of which target contributed the command.
 */
function checkTargetScripts(
  root: string,
  config: KitConfig,
  workspaceNames: Set<string>,
  verifyInstalled: boolean,
): {
  findings: Finding[];
  rootFixCommands: Set<string>;
  rootVerifyCommands: Set<string>;
  anyVerifyCommand: boolean;
} {
  const findings: Finding[] = [];
  const fixAtRoot = runsAtRepoRoot(config.fix);
  const verifyAtRoot = runsAtRepoRoot(config.verify);
  const rootFixCommands = new Set<string>();
  const rootVerifyCommands = new Set<string>();
  let anyVerifyCommand = Boolean(config.verify?.commands?.length);

  for (const target of config.targets ?? []) {
    if (target.pathPrefix && !existsSync(join(root, target.pathPrefix))) {
      findings.push({
        level: 'WARN',
        msg: `target "${target.name}": pathPrefix ${target.pathPrefix} does not exist`,
      });
    }
    if (target.sourcePath && !existsSync(join(root, target.sourcePath))) {
      findings.push({
        level: 'WARN',
        msg: `target "${target.name}": sourcePath ${target.sourcePath} does not exist`,
      });
    }
    if (
      workspaceNames.size &&
      target.packageName !== '.' &&
      !workspaceNames.has(target.packageName)
    ) {
      findings.push({
        level: 'WARN',
        msg: `target "${target.name}": package ${target.packageName} not found in the workspace`,
      });
    }
    const pkgDir = target.pathPrefix ? join(root, target.pathPrefix) : root;
    const scripts = readJson(join(pkgDir, 'package.json'))?.scripts ?? {};
    const fixCommands = resolveTargetCommands(
      target.fixCommands,
      config.fix?.commands as string[] | undefined,
    );
    for (const cmd of fixCommands) {
      if (fixAtRoot) rootFixCommands.add(cmd);
      else if (!scripts[cmd])
        findings.push({
          level: 'WARN',
          msg: `target "${target.name}": fix script "${cmd}" not in ${target.pathPrefix || './'}package.json`,
        });
    }
    // Only a target's EXPLICIT verifyCommands, never the global `verify` fallback,
    // which sub-packages routinely lack because they rely on a root verify. A `null`
    // reads the same as absent here, since either way there is nothing named to check.
    if (target.verifyCommands?.length) anyVerifyCommand = true;
    if (verifyInstalled)
      for (const cmd of target.verifyCommands ?? []) {
        if (verifyAtRoot) rootVerifyCommands.add(cmd);
        else if (!scripts[cmd])
          findings.push({
            level: 'WARN',
            msg: `target "${target.name}": verify script "${cmd}" not in ${target.pathPrefix || './'}package.json`,
          });
      }
  }

  return { findings, rootFixCommands, rootVerifyCommands, anyVerifyCommand };
}

/** The commands the repo-root shape runs, checked once against the root `package.json`. */
function checkRootScripts(
  root: string,
  rootFixCommands: Set<string>,
  rootVerifyCommands: Set<string>,
): Finding[] {
  if (!rootFixCommands.size && !rootVerifyCommands.size) return [];
  const findings: Finding[] = [];
  const rootScripts = readJson(join(root, 'package.json'))?.scripts ?? {};
  for (const cmd of rootFixCommands)
    if (!rootScripts[cmd])
      findings.push({
        level: 'WARN',
        msg: `fix script "${cmd}" not in the root package.json — fix.filterFlag is empty, so every fix command runs as a root script`,
      });
  for (const cmd of rootVerifyCommands)
    if (!rootScripts[cmd])
      findings.push({
        level: 'WARN',
        msg: `verify script "${cmd}" not in the root package.json — verify.filterFlag is empty, so every verify command runs as a root script`,
      });
  return findings;
}

/**
 * A workspace member no target covers silently misses lint-fix, reviewer, and ledger
 * coverage while doctor still reports healthy. A workspace package that a `plugins[]`
 * entry resolves to is tooling for the kit, not reviewable product code, so it is
 * exempt. Matched on the resolved directory, since a repo-relative `plugins[]` entry
 * never carries the package name.
 */
function checkWorkspaceCoverage(
  config: KitConfig,
  registry: Registry,
  workspacePackages: ReturnType<typeof listWorkspacePackages>,
): Finding[] {
  const findings: Finding[] = [];
  const targeted = new Set((config.targets ?? []).map((t) => t.packageName));
  const pluginDirs = new Set(registry.plugins.map((p) => p.dir));
  for (const p of workspacePackages) {
    if (!targeted.has(p.name) && !pluginDirs.has(p.dir))
      findings.push({
        level: 'WARN',
        msg: `workspace package "${p.name}" (${p.relDir}) has no kit target — add one to .claude/kit.config.json targets[] by hand (re-running init skips the existing config)`,
      });
  }
  return findings;
}

/**
 * Whether `.claude/kit.config.json` satisfies the schema and describes a repo that
 * actually exists: every target's paths, package, and named scripts, plus any workspace
 * package no target covers.
 *
 * The schema gate is absolute. A config the schema rejects is one whose fields cannot be
 * trusted to be the types this function reads them as, so a rejection returns
 * immediately rather than walking `targets` that may not be an array. Reporting what a
 * malformed config "says" about the repo would be reporting noise, and the user's next
 * action is the same either way: fix the config and run doctor again.
 */
export function checkConfigValidity(root: string, ctx: Ctx): ConfigValidity {
  const findings: Finding[] = [];
  const configProblems: string[] = [];
  const config = ctx.claude.kitConfig;
  const manifest = ctx.claude.manifest;

  if (!config) {
    findings.push({
      level: manifest ? 'ERROR' : 'WARN',
      msg: 'no .claude/kit.config.json',
    });
    return { findings, readouts: [], configProblems, registry: null };
  }

  // Schema validation runs first: a rejected config is one the hooks are silently
  // misreading, and the field name beats the downstream symptom.
  const raw = readFileSync(join(root, '.claude', 'kit.config.json'), 'utf8');
  configProblems.push(...validateKitConfig(raw));
  for (const problem of configProblems) {
    findings.push({ level: 'ERROR', msg: `kit.config.json: ${problem}` });
  }
  if (configProblems.length)
    return { findings, readouts: [], configProblems, registry: null };

  // A plugin that cannot load gates exactly like a schema rejection: every later
  // check would read a tree it cannot attribute, and `--fix` would plan writes from
  // it. Recorded as a config problem, not just a finding, so `doctor()`'s existing
  // `configProblems.length` gate stops the run before drift reconciliation can write.
  let registry: Registry;
  try {
    registry = buildRegistry(root, config, MODULES);
  } catch (error) {
    if (!(error instanceof PluginResolutionError)) throw error;
    const msg = `plugin "${error.pluginName}": ${error.message}`;
    configProblems.push(msg);
    findings.push({ level: 'ERROR', msg });
    return { findings, readouts: [], configProblems, registry: null };
  }

  const workspacePackages = listWorkspacePackages(root);
  const workspaceNames = new Set(workspacePackages.map((p) => p.name));
  const verifyInstalled = Boolean(
    manifest?.modules?.includes('verify-changed'),
  );

  const targetResult = checkTargetScripts(
    root,
    config,
    workspaceNames,
    verifyInstalled,
  );
  findings.push(...targetResult.findings);
  findings.push(
    ...checkRootScripts(
      root,
      targetResult.rootFixCommands,
      targetResult.rootVerifyCommands,
    ),
  );

  // The per-target loop above walks only NAMED verify commands, so a repo that names none
  // anywhere is exactly the repo it says nothing about. That repo's verify-changed.mts
  // --run degrades to a no-op message instead of failing, so doctor is what catches it.
  if (verifyInstalled && !targetResult.anyVerifyCommand)
    findings.push({
      level: 'WARN',
      msg: 'verify-changed is installed but no verify command is configured — add a "verify" block to .claude/kit.config.json, or "verifyCommands" to each target. Without one --run has nothing to run.',
    });

  findings.push(...checkWorkspaceCoverage(config, registry, workspacePackages));

  return { findings, readouts: [], configProblems, registry };
}
