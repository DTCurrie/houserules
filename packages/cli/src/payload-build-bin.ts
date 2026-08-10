#!/usr/bin/env node
/**
 * `agent-kit-payload`, assembling `payload-dist/` and rewriting cross-package imports, run
 * after a plugin's `tsc`.
 *
 * Usage: `agent-kit-payload [payload-root]`, defaulting to `payload-dist` beside the cwd.
 *
 * Exits 0 after writing the sidecar, or 1 with the reason on stderr. A plugin chains it in
 * `build:payload`, so a non-zero exit has to fail that script rather than pass silently.
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
