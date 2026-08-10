#!/usr/bin/env node
// Committed launcher, not build output. `bin` targets are symlinked by the package manager at
// INSTALL time, and on a clean checkout `dist/` does not exist yet, so pointing `bin` straight
// at `dist/payload-build-bin.js` made pnpm skip the link with a warning. Every plugin build ends
// in `agent-kit-payload`, so the skipped link surfaced later as `agent-kit-payload: not found`,
// exit 127. This file always exists, so the link is always created. By the time anything runs
// it, wireit's `../cli:build:ts` dependency has produced the module it imports.
import '../dist/payload-build-bin.js';
