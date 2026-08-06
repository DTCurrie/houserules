#!/usr/bin/env node
/**
 * Assembles payload-dist/ for a plugin whose payload is prose only.
 *
 * The kit's own build compiles `.mts` hook scripts before this step. A plugin with no scripts
 * has nothing to compile, so the whole payload is copied through verbatim. `payload-dist` is
 * the only root the resolver reads, so a plugin must never ship a half-built mixture of
 * sources and output.
 */

import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(ROOT, 'payload');
const OUT = join(ROOT, 'payload-dist');

if (!existsSync(SOURCE)) {
  console.error('payload/ is missing — nothing to assemble.');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
cpSync(SOURCE, OUT, { recursive: true });
console.log(`Assembled ${OUT}`);
