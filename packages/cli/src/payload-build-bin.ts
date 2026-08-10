#!/usr/bin/env node
/**
 * `agent-kit-payload`, assembling `payload-dist/` and rewriting cross-package imports, run
 * after a plugin's `tsc`.
 *
 * Usage: `agent-kit-payload [payload-root]`, defaulting to `payload-dist` beside the cwd.
 *
 * Exits 0 after writing the sidecar, or 1 with the reason on stderr. A plugin chains it in
 * `build:payload`, so a non-zero exit has to fail that script rather than pass silently.
 *
 * Its own file, with nothing exported, because an `import.meta.url === process.argv[1]` guard does
 * not survive being invoked through a bin shim. `argv[1]` keeps the shim's `../` and any symlink
 * component while `import.meta.url` is canonicalized, so the two strings never match and the tool
 * no-ops at exit 0. A build tool that silently does nothing is worse than one that crashes, and a
 * file that is only ever an entry point needs no guard at all.
 */

import { join } from 'node:path';

import {
  assemblePayload,
  buildPayload,
  DEFAULT_PAYLOAD_ROOT,
} from './payload-build.js';

const payloadRoot = join(
  process.cwd(),
  process.argv[2] ?? DEFAULT_PAYLOAD_ROOT,
);

try {
  assemblePayload(payloadRoot, process.cwd());
  buildPayload(payloadRoot, process.cwd());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
