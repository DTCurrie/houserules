import type { SettingsSignature } from './merge-settings.js';
import type { PluginSource } from './plugin-source.js';

export const MANIFEST_PATH = '.claude/houserules.manifest.json';

/**
 * The two hashes a body-owned file records. They answer different questions, so neither
 * substitutes for the other. `body` is what houserules last wrote below the frontmatter, and
 * a mismatch means YOU edited the part houserules owns. `frontmatter` is what houserules shipped
 * as the DEFAULT, and it exists so a customized `paths:` can be told from an untouched one.
 */
export interface BodyHashes {
  body: string;
  frontmatter: string;
}

/** The receipt `.claude/houserules.manifest.json`: what houserules installed and at what hash. */
export interface HouseManifest {
  kitVersion: string;
  installedAt: string;
  modules: string[];
  /**
   * repo-relative dest → what houserules wrote there. A plain string is a sha256 of the whole
   * file. A {@link BodyHashes} is a body-owned file, where houserules wrote only the body.
   * Manifests written before body ownership existed carry the plain string everywhere,
   * including at dests that are body-owned now, which is what the legacy migration in
   * `computeEffects` reads.
   */
  files: Record<string, string | BodyHashes>;
  settings?: SettingsSignature;
  /**
   * The plugins resolved on the run that wrote this manifest, and the version each
   * resolved to. Absent means an install from before plugins existed, never that the
   * config declares none. `update` compares a recorded entry's `version` against what
   * resolves now to tell a plugin upgrade from a local edit to the plugin's own files.
   */
  plugins?: PluginSource[];
}

/**
 * The whole-file hash recorded for `dest`, for the files houserules owns end to end.
 *
 * @returns Undefined when the entry is body-owned, so a caller that means "whole file"
 *   never silently reads a body hash as one. At a body-owned dest a defined result is a
 *   LEGACY entry, written before the split existed.
 */
export function wholeFileHash(
  manifest: HouseManifest | null | undefined,
  dest: string,
): string | undefined {
  const entry = manifest?.files?.[dest];
  return typeof entry === 'string' ? entry : undefined;
}

/**
 * The body and frontmatter hashes recorded for `dest`.
 *
 * @returns Undefined when the dest is absent from the manifest OR carries a legacy
 *   whole-file string. Both mean there is no body hash to compare against, and the caller
 *   decides which of the two it is with {@link wholeFileHash}.
 */
export function bodyHashes(
  manifest: HouseManifest | null | undefined,
  dest: string,
): BodyHashes | undefined {
  const entry = manifest?.files?.[dest];
  return typeof entry === 'object' && entry !== null ? entry : undefined;
}
