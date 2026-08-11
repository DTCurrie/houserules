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

const USAGE = `Usage: agent-kit-payload [payload-root]

Assembles payload-dist/ and rewrites cross-package imports. Run it after a plugin's tsc.

  payload-root  Directory to assemble, relative to the cwd. Defaults to ${DEFAULT_PAYLOAD_ROOT}.

Exits 0 after writing the sidecar, or 1 with the reason on stderr.`;

const arg = process.argv[2];

if (arg === '--help' || arg === '-h') {
  console.log(USAGE);
  process.exit(0);
}

// A path is positional, so anything dash-led is a mistyped flag. Treating it as a directory
// name is how `agent-kit-payload --help` used to write a full build into a folder called
// `--help`, which is not gitignored and gets committed by the next `git add -A`.
if (arg?.startsWith('-')) {
  console.error(`agent-kit-payload: unknown option "${arg}"\n\n${USAGE}`);
  process.exit(1);
}

const payloadRoot = join(process.cwd(), arg ?? DEFAULT_PAYLOAD_ROOT);

try {
  assemblePayload(payloadRoot, process.cwd());
  buildPayload(payloadRoot, process.cwd());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
