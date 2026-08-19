import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The sidecar a payload build writes beside its emitted scripts, naming the CLI libs each emitted
 * file imports.
 *
 * Named for the format rather than for either side of it, because two modules need it and neither
 * owns it. `payload-build.ts` writes the file, and `copy-actions.ts` reads it to decide which libs
 * an install has to copy alongside a plugin's script.
 *
 * `payload-imports.json`, not `cli-libs.json`, so the name survives the substrate moving out of the
 * CLI into a package of its own.
 */
export const PAYLOAD_IMPORTS_FILE = 'payload-imports.json';

/** The specifier prefix a payload file uses to reach a shared payload lib, before the build rewrites it. */
export const PAYLOAD_IMPORT_PREFIX = '@houserules/payload/';

export interface PayloadImports {
  version: 1;
  /**
   * Emitted file, POSIX-relative to the payload root, to the lib basenames it imports.
   *
   * Only VALUE imports appear. A type-only import erases before emit, so it never reaches the
   * `.mjs` and never needs a file copied for it. That is what makes this set exactly the copy set
   * rather than an over-approximation of it.
   */
  libs: Record<string, string[]>;
}

function emptyPayloadImports(): PayloadImports {
  return { version: 1, libs: {} };
}

/**
 * The sidecar in `payloadRoot`, or an empty one when it is absent or unreadable.
 *
 * Defensive on purpose, and this is the compatibility seam. A plugin published before this
 * mechanism existed, or built by an older toolchain, has no sidecar. That plugin must still
 * install, contributing no derived lib copies, exactly as it does today.
 */
export function readPayloadImports(payloadRoot: string): PayloadImports {
  const file = join(payloadRoot, PAYLOAD_IMPORTS_FILE);
  if (!existsSync(file)) return emptyPayloadImports();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isPayloadImports(parsed)) return emptyPayloadImports();
    return parsed;
  } catch {
    return emptyPayloadImports();
  }
}

function isPayloadImports(value: unknown): value is PayloadImports {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { version?: unknown; libs?: unknown };
  if (candidate.version !== 1) return false;
  if (typeof candidate.libs !== 'object' || candidate.libs === null)
    return false;
  return Object.values(candidate.libs).every(
    (names) =>
      Array.isArray(names) && names.every((name) => typeof name === 'string'),
  );
}
