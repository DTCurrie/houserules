// Where the kit's own files live (claude-kit CLI).
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this module's own location, which is one level under the package
// root both in source (src/paths.ts) and in the build output (dist/paths.js), so
// the CLI finds its payload no matter which repo it was invoked against.
export const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The BUILT payload, not the sources: scripts ship as `.mjs` compiled from `.mts`,
// and prose assets are copied alongside them by scripts/build-payload.mjs. One root,
// so the installer can never read a half-built mixture of the two.
const PAYLOAD_ROOT = join(KIT_ROOT, 'payload-dist');

export function payloadPath(...segments: string[]): string {
  return join(PAYLOAD_ROOT, ...segments);
}

/** Clear failure rather than a confusing missing-file error deep in the plan. */
export function assertPayloadBuilt(): void {
  if (existsSync(PAYLOAD_ROOT)) return;
  throw new Error(
    'payload-dist/ is missing — run `pnpm build` before using the CLI from a checkout.',
  );
}
