import type { SettingsSignature } from '../merge-settings.js';

export const MANIFEST_PATH = '.claude/kit-manifest.json';

/** The receipt `.claude/kit-manifest.json`: what the kit installed and at what hash. */
export interface KitManifest {
  kitVersion: string;
  installedAt: string;
  modules: string[];
  /** repo-relative dest → sha256 of the content the kit wrote. */
  files: Record<string, string>;
  settings?: SettingsSignature;
}
