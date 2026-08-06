#!/usr/bin/env node
/**
 * Assembles payload-dist/ for a plugin that ships prose, and optionally `.mts` scripts.
 *
 * When payload/scripts exists, tsconfig.payload.json must compile it into payload-dist/scripts
 * before this runs, so this step only copies the prose dirs through verbatim. A plugin with no
 * payload/scripts has nothing to compile, and assembling its prose is the whole job.
 * `payload-dist` is the only root the resolver reads, so the plugin must never ship a
 * half-built mixture of sources and output.
 */

import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(ROOT, 'payload');
const OUT = join(ROOT, 'payload-dist');

const VERBATIM = ['rules', 'reference', 'skills', 'agents'];

const hasScriptSources = existsSync(join(SOURCE, 'scripts'));
if (hasScriptSources && !existsSync(join(OUT, 'scripts'))) {
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

const parts = hasScriptSources ? [...VERBATIM, 'compiled scripts'] : VERBATIM;
console.log(`Assembled payload-dist (${parts.join(', ')})`);
