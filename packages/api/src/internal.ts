/**
 * `@agent-kit/api/internal` is NOT the plugin contract. It is how the installer's own code,
 * split across `@agent-kit/cli` and this package, reaches shared types and functions that a
 * plugin author has no business calling: settings-file merging, region splicing, config-file
 * validation, the installed manifest, and the rest of what detection produces beyond `Ctx`
 * and `Target`.
 *
 * Everything here can change or disappear in a minor release. A plugin author who needs
 * something from this module instead of `@agent-kit/api` has found a gap in the contract,
 * not a reason to import from here: file it against `index.ts` instead.
 */

export { extractBody, hasLegacyRegion, upsertRegion } from './regions.js';
export type { UpsertStatus } from './regions.js';

export {
  mergeSettings,
  parseSettingsText,
  removeHooksByScript,
  removeSettingsFragments,
  renderSettings,
  settingsSignature,
} from './merge-settings.js';
export type {
  SettingsChange,
  SettingsPlan,
  SettingsSignature,
} from './merge-settings.js';

export {
  buildJsonSchema,
  KitConfigError,
  parseKitConfig,
  validateKitConfig,
} from './config.js';

export { bodyHashes, MANIFEST_PATH, wholeFileHash } from './manifest.js';
export type { BodyHashes, KitManifest } from './manifest.js';

export type { PluginSource } from './plugin-source.js';

export type {
  ChangesetInvocation,
  ChangesetsState,
  ClaudeState,
  GitState,
  PackageManagerInfo,
  PackageManagerSource,
} from './ctx.js';

export { createPayloadBuilders } from './copy-actions.js';
