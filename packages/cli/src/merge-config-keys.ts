/**
 * The keys the kit reconciles inside `.claude/kit.config.json`, a file the USER owns.
 *
 * This is the JSON analogue of what {@link ./merge-settings.ts} does to `settings.json`. The
 * file belongs to the user end to end, and the kit writes only the named keys, so every other
 * key, and the user's own edits to the managed ones, survive a run untouched.
 */

/** Deep structural equality, enough for the JSON shapes a config key can hold. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Splices the kit's value for each key in `managedKeys` into `diskText`.
 *
 * A key the canonical render omits is REMOVED from the result rather than left behind. That is
 * what makes a withdrawal work: when a module's options resolve to nothing the key has to
 * disappear, not linger and get re-read as a selection on the next run.
 *
 * An unparseable `diskText` returns null and the file is left alone. `readJson` in `detect.ts`
 * already reads a malformed config as absent, and `doctor`'s `checkConfigValidity` is the gate
 * that reports it. Rewriting a file we could not parse would destroy whatever the user was in
 * the middle of fixing.
 *
 * @param canonicalText The whole config as a fresh install would render it, the single source
 *   for what each managed key should hold. Taking it from the same renderer the seed uses is
 *   what keeps the fresh-install and merge paths from drifting.
 * @returns The new file text, or null when nothing changed or nothing could be parsed.
 */
export function mergeManagedKeys(
  diskText: string,
  canonicalText: string,
  managedKeys: string[],
): string | null {
  let onDisk: Record<string, unknown>;
  let canonical: Record<string, unknown>;
  try {
    onDisk = JSON.parse(diskText) as Record<string, unknown>;
    canonical = JSON.parse(canonicalText) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (onDisk === null || typeof onDisk !== 'object' || Array.isArray(onDisk))
    return null;

  const merged = { ...onDisk };
  let changed = false;
  for (const key of managedKeys) {
    const wanted = canonical[key];
    if (wanted === undefined) {
      if (key in merged) {
        delete merged[key];
        changed = true;
      }
      continue;
    }
    if (!(key in merged) || !sameJson(merged[key], wanted)) {
      merged[key] = wanted;
      changed = true;
    }
  }
  if (!changed) return null;
  return `${JSON.stringify(merged, null, 2)}\n`;
}
