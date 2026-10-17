#!/usr/bin/env node
// The bare name has to carry its own bin for `npx houserules` to resolve; it defers to the
// cli's committed launcher so there is one entry point to maintain.
import '@houserules/cli/bin/houserules.mjs';
