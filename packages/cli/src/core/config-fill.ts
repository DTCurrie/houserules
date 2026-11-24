import { mergeManagedKeys } from '../merge-config-keys.js';
import { validateHouseConfig } from '@houserules/api/internal';

/** The outcome of trying to complete a partial on-disk config. */
interface ConfigFill {
  /** Top-level keys the user left unset that the fresh render supplies. */
  missingKeys: string[];
  /** Schema problems left once the missing keys are filled. Empty means the fill is enough. */
  problems: string[];
}

/**
 * Finds the top-level keys absent from `diskText` that `canonicalText` supplies, and validates
 * the file as it would read with only those keys added. A key the user set is never in
 * `missingKeys`, so an invalid user value still shows up in `problems`.
 *
 * Returns null when `diskText` is not a JSON object, so the caller falls back to the plain
 * schema report on the original file.
 */
export function planConfigFill(
  diskText: string,
  canonicalText: string,
): ConfigFill | null {
  let onDisk: unknown;
  let canonical: Record<string, unknown>;
  try {
    onDisk = JSON.parse(diskText);
    canonical = JSON.parse(canonicalText) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (onDisk === null || typeof onDisk !== 'object' || Array.isArray(onDisk))
    return null;
  const missingKeys = Object.keys(canonical).filter((key) => !(key in onDisk));
  const filled = mergeManagedKeys(diskText, canonicalText, missingKeys);
  return {
    missingKeys,
    problems: validateHouseConfig(filled ?? diskText),
  };
}

/**
 * True when every schema problem names a top-level key that `diskText` does not set, the only
 * kind of problem a fill from the seed can repair. A problem on a key the user set, or on a
 * nested path, is not.
 */
export function onlyMissingTopLevelKeys(
  diskText: string,
  problems: string[],
): boolean {
  let onDisk: unknown;
  try {
    onDisk = JSON.parse(diskText);
  } catch {
    return false;
  }
  if (onDisk === null || typeof onDisk !== 'object' || Array.isArray(onDisk))
    return false;
  return problems.every((problem) => {
    const path = problem.split(' ')[0] ?? '';
    return path !== '' && !path.includes('.') && !(path in onDisk);
  });
}
