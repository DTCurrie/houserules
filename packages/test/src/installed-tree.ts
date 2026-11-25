import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Throws on a missing or malformed file, unlike the payload's defensive reader. A test that
 * cannot find the artifact it is about should fail loudly rather than assert against null.
 */
export function readJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface Hook {
  type?: string;
  command?: string;
}

export interface HookGroup {
  matcher?: string;
  hooks?: Hook[];
}

export interface Settings {
  // All three lists `merge-settings.ts` reconciles. A type carrying only `allow` makes a
  // suite that asserts on a deny entry fail to typecheck while passing at runtime.
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

export function settingsOf(root: string): Settings {
  return readJson<Settings>(join(root, '.claude/settings.json'));
}

/** Every hook command wired to one event, flattened out of its matcher groups. */
export function hookCommandsFor(settings: Settings, event: string): string[] {
  return (settings.hooks?.[event] ?? []).flatMap((group) =>
    (group.hooks ?? []).map((hook) => hook.command ?? ''),
  );
}

/** The shape of `.claude/scripts/hook-wiring.json`, the file the hook dispatcher reads. */
interface HookWiringShape {
  version: number;
  events: Record<
    string,
    { script: string; matcher?: string; timeout?: number; onFailure?: string }[]
  >;
}

const SCRIPTS_RELATIVE_DIR = '.claude/scripts/';
export const HOOK_WIRING_RELATIVE_PATH = `${SCRIPTS_RELATIVE_DIR}hook-wiring.json`;
const EMPTY_WIRING_VERSION = 1;

/** The installed hook wiring, or one with no events when the install wrote none. */
export function hookWiringOf(root: string): HookWiringShape {
  const path = join(root, HOOK_WIRING_RELATIVE_PATH);
  if (!existsSync(path)) return { version: EMPTY_WIRING_VERSION, events: {} };
  return readJson<HookWiringShape>(path);
}

/** Every script the dispatcher runs for one event, in wiring order. */
export function dispatchedScriptsFor(root: string, event: string): string[] {
  return (hookWiringOf(root).events[event] ?? []).map((entry) => entry.script);
}

/**
 * Every hook command in settings, plus `.claude/scripts/<script>` for each script the
 * dispatcher runs, so an assertion that no hook names a module still sees dispatched hooks.
 */
export function allHookCommands(root: string): string[] {
  const settings = settingsOf(root);
  const settingsCommands = Object.keys(settings.hooks ?? {}).flatMap((event) =>
    hookCommandsFor(settings, event),
  );
  const dispatchedPaths = Object.values(hookWiringOf(root).events).flatMap(
    (entries) =>
      entries.map((entry) => `${SCRIPTS_RELATIVE_DIR}${entry.script}`),
  );
  return [...settingsCommands, ...dispatchedPaths];
}

export interface HouseManifestShape {
  files: Record<string, string>;
  modules: string[];
  [key: string]: unknown;
}

export function manifestOf(root: string): HouseManifestShape {
  return readJson<HouseManifestShape>(
    join(root, '.claude/houserules.manifest.json'),
  );
}

export function writeManifest(
  root: string,
  manifest: HouseManifestShape,
): void {
  writeFileSync(
    join(root, '.claude/houserules.manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

/**
 * The config as the PAYLOAD sees it: read defensively and never zod-validated. Deliberately
 * not the inferred `HouseConfig` from `src/core/config.ts`, which would couple the payload side
 * of the suite to the CLI side the repo works to keep apart.
 */
export type InstalledHouseConfig = Record<string, unknown>;

export function houseConfigPath(root: string): string {
  return join(root, '.claude/houserules.config.json');
}

export function editHouseConfig(
  root: string,
  edit: (config: InstalledHouseConfig) => void,
): void {
  const config = readJson<InstalledHouseConfig>(houseConfigPath(root));
  edit(config);
  writeFileSync(houseConfigPath(root), JSON.stringify(config, null, 2));
}

interface FixTargetShape {
  pathPrefix?: string;
  fixCommands?: string[] | null;
}

/**
 * Rewrites every fix script the installed config names, in each target's own package.json, to
 * the path-taking `eslint --fix`, and turns `fix.passPaths` on. `doctor` then has nothing to
 * say about the Stop fix step, so a suite about another concern can assert a warning-free run.
 */
export function givePathTakingFixScripts(root: string): void {
  const config = readJson<InstalledHouseConfig>(houseConfigPath(root));
  const fix = (config.fix ?? {}) as Record<string, unknown>;
  const fallbackCommands = (fix.commands ?? []) as string[];
  for (const target of (config.targets ?? []) as FixTargetShape[]) {
    const packageJsonPath = join(root, target.pathPrefix ?? '', 'package.json');
    const packageJson = readJson<{ scripts?: Record<string, string> }>(
      packageJsonPath,
    );
    for (const name of target.fixCommands ?? fallbackCommands) {
      packageJson.scripts = { ...packageJson.scripts, [name]: 'eslint --fix' };
    }
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  }
  editHouseConfig(root, (edited) => {
    edited.fix = { ...fix, passPaths: true };
  });
}

export const REGION_START = '<!-- houserules:claude-md start -->';
export const REGION_END = '<!-- houserules:claude-md end -->';

export function claudeMdPath(root: string): string {
  return join(root, 'CLAUDE.md');
}

export function readClaudeMd(root: string): string {
  return readFileSync(claudeMdPath(root), 'utf8');
}
