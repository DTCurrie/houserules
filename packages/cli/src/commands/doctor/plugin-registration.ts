import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { Ctx } from '../../detect.js';
import { KIT_ROOT } from '../../paths.js';
import type { CheckResult, Finding } from './finding.js';

/**
 * The `keywords` entry a package declares to say it contributes agent-kit modules. Gating
 * discovery on it is what keeps this check from scanning `node_modules` wholesale and
 * guessing from names.
 */
const PLUGIN_KEYWORD = 'agent-kit-plugin';

interface PackageJson {
  name?: string;
  keywords?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PluginCandidate {
  packageName: string;
  dir: string;
}

function readPackageJson(dir: string): PackageJson | null {
  try {
    return JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8'),
    ) as PackageJson;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(
        `agent-kit: could not read ${join(dir, 'package.json')} (${(error as Error).message}). Treating ${dir} as if it were not a package.`,
      );
    }
    return null;
  }
}

/** One spelling for a directory, so a symlinked workspace compares equal to its real path. */
function canonical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

function asCandidate(
  dir: string,
  fallbackName: string,
): PluginCandidate | null {
  const pkg = readPackageJson(dir);
  if (!pkg?.keywords?.includes(PLUGIN_KEYWORD)) return null;
  return { packageName: pkg.name ?? fallbackName, dir: canonical(dir) };
}

/**
 * Plugin packages sitting beside the running CLI in its own checkout.
 *
 * This is the case a dependency scan cannot see. A repo can consume a plugin by relative path
 * (`../agent-kit/packages/plugin-accessibility`) without naming it in its own package.json at
 * all, and then nothing in the host repo mentions the plugin until config does.
 */
function siblingPlugins(): PluginCandidate[] {
  const parent = dirname(KIT_ROOT);
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }
  const found: PluginCandidate[] = [];
  for (const entry of entries) {
    const dir = join(parent, entry);
    if (canonical(dir) === canonical(KIT_ROOT)) continue;
    const candidate = asCandidate(dir, entry);
    if (candidate) found.push(candidate);
  }
  return found;
}

/** Plugin packages the host repo depends on directly, which is the ordinary npm install. */
function dependencyPlugins(root: string): PluginCandidate[] {
  const hostPackage = readPackageJson(root);
  if (!hostPackage) return [];
  const names = [
    ...Object.keys(hostPackage.dependencies ?? {}),
    ...Object.keys(hostPackage.devDependencies ?? {}),
  ];
  const requireFromRoot = createRequire(join(root, 'package.json'));
  const found: PluginCandidate[] = [];
  for (const name of names) {
    try {
      const dir = dirname(requireFromRoot.resolve(join(name, 'package.json')));
      const candidate = asCandidate(dir, name);
      if (candidate) found.push(candidate);
    } catch {
      /* Not installed, or not resolvable from here. Not this check's problem. */
    }
  }
  return found;
}

/** Where each config entry actually points, best-effort and never throwing. */
function registeredDirs(root: string, ctx: Ctx): Set<string> {
  const dirs = new Set<string>();
  for (const entry of ctx.claude.kitConfig?.plugins ?? []) {
    const name = entry.name;
    if (name.startsWith('./') || name.startsWith('../') || isAbsolute(name)) {
      dirs.add(canonical(resolve(root, name)));
      continue;
    }
    const local = join(root, name);
    if (readPackageJson(local)) {
      dirs.add(canonical(local));
      continue;
    }
    try {
      const requireFromRoot = createRequire(join(root, 'package.json'));
      dirs.add(
        canonical(dirname(requireFromRoot.resolve(join(name, 'package.json')))),
      );
    } catch {
      /* An unresolvable entry is checkConfigValidity's and the resolver's problem. */
    }
  }
  return dirs;
}

function sortedNames(candidates: Map<string, PluginCandidate>): string[] {
  return [...candidates.values()]
    .map((c) => c.packageName)
    .sort((a, b) => a.localeCompare(b));
}

function unregistered(
  found: PluginCandidate[],
  registered: Set<string>,
): Map<string, PluginCandidate> {
  const out = new Map<string, PluginCandidate>();
  for (const candidate of found) {
    if (registered.has(candidate.dir)) continue;
    out.set(candidate.dir, candidate);
  }
  return out;
}

/**
 * Plugins this install could offer but never registers.
 *
 * `buildRegistry` iterates `kit.config.json`'s `plugins` array and nothing else, so a plugin
 * that is present and resolvable but unlisted contributes no modules and is invisible
 * everywhere. `modules` then reports "Every module is already installed", which is true of the
 * registry it built and misleading about the kit.
 *
 * The two discovery modes carry different signal, so they are reported differently. A plugin
 * the repo DEPENDS on and does not register is an oversight worth a WARN: someone installed
 * the package on purpose and gets nothing from it. A plugin that merely sits beside the CLI in
 * a checkout is not evidence of intent at all, so it is one readout line naming what is
 * available. Reporting those as warnings meant a plain `init` in a workspace raised seven,
 * none of which described a problem.
 *
 * Never ERROR either way. Declining a plugin is a legitimate choice.
 */
export function checkPluginRegistration(root: string, ctx: Ctx): CheckResult {
  const findings: Finding[] = [];
  const readouts: string[] = [];

  if (!ctx.claude.manifest) return { findings, readouts };

  const registered = registeredDirs(root, ctx);
  const declared = unregistered(dependencyPlugins(root), registered);
  for (const packageName of sortedNames(declared)) {
    findings.push({
      level: 'WARN',
      msg: `plugin ${packageName} is a dependency of this repo but is not in kit.config.json "plugins", so none of its modules are available`,
    });
  }

  const nearby = unregistered(siblingPlugins(), registered);
  for (const dir of declared.keys()) nearby.delete(dir);
  if (nearby.size) {
    readouts.push(
      `plugins available beside the CLI but not registered: ${sortedNames(nearby).join(', ')}`,
    );
  }

  return { findings, readouts };
}
