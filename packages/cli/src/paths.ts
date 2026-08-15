import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * houserules' own package root, resolved from this module's location. That location is
 * one level under the root in both source (`src/paths.ts`) and build output
 * (`dist/paths.js`), so the CLI finds its payload whatever repo it was invoked against.
 */
export const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The BUILT payload, not the sources. One root, so the installer can never read a
// half-built mixture of compiled scripts and copied prose.
const PAYLOAD_ROOT = join(KIT_ROOT, 'payload-dist');

/** Resolves a path inside the built payload that ships to user repos. */
export function payloadPath(...segments: string[]): string {
  return join(PAYLOAD_ROOT, ...segments);
}
