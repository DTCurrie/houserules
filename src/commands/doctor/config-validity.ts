import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  listWorkspacePackages,
  readJson,
} from '../../../payload-dist/scripts/lib/workspaces.mjs';
import { validateKitConfig } from '../../core/config.js';
import type { Ctx } from '../../detect.js';
import type { CheckResult, Finding } from './finding.js';

const CURRENT_CONFIG_VERSION = 2;

export interface ConfigValidity extends CheckResult {
  /**
   * Schema rejections, kept apart from the findings so the exit code can distinguish
   * "your config is not valid" (2) from "your install has a problem" (1).
   */
  configProblems: string[];
}

/**
 * Whether `.claude/kit.config.json` satisfies the schema and describes a repo that
 * actually exists: every target's paths, package, and named scripts, plus any workspace
 * package no target covers.
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
    return { findings, readouts: [], configProblems };
  }

  // Schema validation runs first: a rejected config is one the hooks are silently
  // misreading, and the field name beats the downstream symptom.
  const raw = readFileSync(join(root, '.claude', 'kit.config.json'), 'utf8');
  configProblems.push(...validateKitConfig(raw));
  for (const problem of configProblems) {
    findings.push({ level: 'ERROR', msg: `kit.config.json: ${problem}` });
  }

  if (config.version !== CURRENT_CONFIG_VERSION)
    findings.push({
      level: 'WARN',
      msg: `kit.config.json version ${config.version ?? 1} (current schema: ${CURRENT_CONFIG_VERSION})`,
    });

  const workspacePackages = listWorkspacePackages(root);
  const workspaceNames = new Set(workspacePackages.map((p) => p.name));
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
    const fixCommands =
      target.fixCommands ??
      (config.fix?.commands as string[] | undefined) ??
      [];
    for (const cmd of fixCommands) {
      if (!scripts[cmd])
        findings.push({
          level: 'WARN',
          msg: `target "${target.name}": fix script "${cmd}" not in ${target.pathPrefix || './'}package.json`,
        });
    }
    // Only a target's EXPLICIT verifyCommands, never the global `verify` fallback,
    // which sub-packages routinely lack because they rely on a root verify.
    if (manifest?.modules?.includes('verify-changed'))
      for (const cmd of target.verifyCommands ?? []) {
        if (!scripts[cmd])
          findings.push({
            level: 'WARN',
            msg: `target "${target.name}": verify script "${cmd}" not in ${target.pathPrefix || './'}package.json`,
          });
      }
  }

  // A workspace member no target covers silently misses lint-fix, reviewer, and ledger
  // coverage while doctor still reports healthy.
  const targeted = new Set((config.targets ?? []).map((t) => t.packageName));
  for (const p of workspacePackages) {
    if (!targeted.has(p.name))
      findings.push({
        level: 'WARN',
        msg: `workspace package "${p.name}" (${p.relDir}) has no kit target — add one to .claude/kit.config.json targets[] by hand (re-running init skips the existing config)`,
      });
  }

  return { findings, readouts: [], configProblems };
}
