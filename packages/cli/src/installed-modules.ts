import type { HouseConfig } from '@houserules/api';
import type { HouseManifest } from '@houserules/api/internal';

/**
 * The enabled module ids for an install. The tracked config is read first, because a fresh
 * clone carries the config and no manifest. The manifest is the fallback for an install from
 * before the config recorded `modules`.
 *
 * @returns Undefined when neither source names a module, so each caller keeps its own default
 *   (`['core']` where it plans, `[]` where it only reports).
 */
export function installedModuleIds(
  houseConfig: HouseConfig | null | undefined,
  manifest: HouseManifest | null | undefined,
): string[] | undefined {
  if (houseConfig?.modules?.length) return houseConfig.modules;
  return manifest?.modules;
}
