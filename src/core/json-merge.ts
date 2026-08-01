// Pure deep JSON merge/remove primitives. No filesystem access — callers (settings
// planning, apply) own I/O; this module only transforms in-memory JSON values.
//
// Immutability: deepMerge and deepRemove never mutate `target` or `patch`. Both return
// a fresh object (and fresh nested objects/arrays wherever the patch touches them);
// unvisited branches of `target` are reused as-is. Callers may safely re-merge/re-remove
// the same patch against the same target without side effects leaking between calls.

import { dequal } from 'dequal';
import type { JsonObject, JsonValue } from 'type-fest';

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses JSON text expected to hold an object; throws if it is anything else. */
export function parseJsonObject(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isPlainObject(value)) throw new Error('expected a JSON object');
  return value;
}

/** A host file we manage only a few keys of. Blank/whitespace counts as `{}`. */
export function parseHostJson(text: string): JsonObject {
  return text.trim() === '' ? {} : parseJsonObject(text);
}

/**
 * Deep-merges `patch` into `target`: nested objects recurse, arrays union by
 * structural equality (so repeated merges are idempotent), scalars overwrite.
 * Returns a fresh object; `target` and `patch` are left untouched.
 */
export function deepMerge(target: JsonObject, patch: JsonObject): JsonObject {
  const result: JsonObject = { ...target };
  for (const [key, patchValue] of Object.entries(patch) as [
    string,
    JsonValue,
  ][]) {
    const current = result[key];
    if (isPlainObject(current) && isPlainObject(patchValue)) {
      result[key] = deepMerge(current, patchValue);
    } else if (Array.isArray(current) && Array.isArray(patchValue)) {
      const merged = [...current];
      for (const element of patchValue) {
        if (!merged.some((existing) => dequal(existing, element)))
          merged.push(element);
      }
      result[key] = merged;
    } else {
      result[key] = patchValue;
    }
  }
  return result;
}

/**
 * Deep-removes `patch` from `target`: a scalar patch value deletes its key, an array
 * patch value removes structurally-equal elements, objects recurse. Emptied objects
 * and arrays are pruned so no hollow containers linger. Returns a fresh object;
 * `target` and `patch` are left untouched.
 */
export function deepRemove(target: JsonObject, patch: JsonObject): JsonObject {
  const result: JsonObject = { ...target };
  for (const [key, patchValue] of Object.entries(patch) as [
    string,
    JsonValue,
  ][]) {
    const current = result[key];
    if (isPlainObject(current) && isPlainObject(patchValue)) {
      const removed = deepRemove(current, patchValue);
      if (Object.keys(removed).length === 0) delete result[key];
      else result[key] = removed;
    } else if (Array.isArray(current) && Array.isArray(patchValue)) {
      const kept = current.filter(
        (el) => !patchValue.some((p) => dequal(p, el)),
      );
      if (kept.length === 0) delete result[key];
      else result[key] = kept;
    } else if (key in result) {
      delete result[key];
    }
  }
  return result;
}
