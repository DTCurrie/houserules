import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
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

export function allHookCommands(root: string): string[] {
  const settings = settingsOf(root);
  return Object.keys(settings.hooks ?? {}).flatMap((event) =>
    hookCommandsFor(settings, event),
  );
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

export const REGION_START = '<!-- houserules:claude-md start -->';
export const REGION_END = '<!-- houserules:claude-md end -->';

export function claudeMdPath(root: string): string {
  return join(root, 'CLAUDE.md');
}

export function readClaudeMd(root: string): string {
  return readFileSync(claudeMdPath(root), 'utf8');
}
