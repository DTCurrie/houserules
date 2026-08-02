#!/usr/bin/env node
/**
 * Assembles payload-dist/, the tree that ships and gets copied into user repos. `.mts`
 * sources are compiled by tsconfig.payload.json, which runs before this. Everything else
 * under payload/ is prose and is copied through verbatim.
 *
 * One root, not two. `src/paths.ts` resolves `payloadPath()` to payload-dist, so the
 * installer never reads a half-built mixture of sources and output.
 */

import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(ROOT, 'payload');
const OUT = join(ROOT, 'payload-dist');

const VERBATIM = [
  'skills',
  'agents',
  'rules',
  'output-styles',
  'kit-templates',
];

if (!existsSync(join(OUT, 'scripts'))) {
  console.error(
    'payload-dist/scripts is missing — run `tsc -p tsconfig.payload.json` first.',
  );
  process.exit(1);
}

for (const dir of VERBATIM) {
  const from = join(SOURCE, dir);
  if (!existsSync(from)) continue;
  const to = join(OUT, dir);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

console.log(
  `Assembled payload-dist (${VERBATIM.join(', ')} + compiled scripts)`,
);
