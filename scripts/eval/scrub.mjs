#!/usr/bin/env node
/**
 * `node scripts/eval/scrub.mjs <dir>`: replaces every occurrence of the `EVAL_SCRUB_KEY`
 * value in every file under <dir> with `[REDACTED]` and prints how many files changed.
 * An empty or unset key exits 2. The key is never printed.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_USAGE = 2;

/**
 * @param {string} dir
 * @param {string} key
 * @returns {number} How many files changed.
 */
function scrubDir(dir, key) {
  let changed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      changed += scrubDir(path, key);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = readFileSync(path);
    if (!bytes.includes(key)) continue;
    writeFileSync(
      path,
      bytes
        .toString('latin1')
        .split(Buffer.from(key).toString('latin1'))
        .join('[REDACTED]'),
      'latin1',
    );
    changed += 1;
  }
  return changed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const key = process.env.EVAL_SCRUB_KEY ?? '';
  const dir = process.argv[2];
  if (key === '' || dir === undefined) {
    process.stderr.write(
      'usage: EVAL_SCRUB_KEY=<key> scrub.mjs <dir> (the key must be non-empty)\n',
    );
    process.exit(EXIT_USAGE);
  }
  process.stdout.write(`${scrubDir(dir, key)}\n`);
}
