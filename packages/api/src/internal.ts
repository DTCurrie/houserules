/**
 * `@houserules/api/internal` is NOT the plugin contract. It is how the installer's own code,
 * split across `@houserules/cli` and this package, reaches shared types and functions that a
 * plugin author has no business calling: settings-file merging, region splicing, config-file
 * validation, the installed manifest, and the rest of what detection produces beyond `Ctx`
 * and `Target`.
 *
 * Everything here can change or disappear in a minor release. A plugin author who needs
 * something from this module instead of `@houserules/api` has found a gap in the contract,
 * not a reason to import from here: file it against `index.ts` instead.
 */

export { extractBody, hasLegacyRegion, upsertRegion } from './regions.js';

export {
  isKitStockCommand,
  mergeSettings,
  parseSettingsText,
  reconcileSettings,
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
  HouseConfigError,
  parseHouseConfig,
  validateHouseConfig,
} from './config.js';

export { bodyHashes, MANIFEST_PATH, wholeFileHash } from './manifest.js';
export type { BodyHashes, HouseManifest } from './manifest.js';

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
