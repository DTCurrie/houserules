#!/usr/bin/env node
// Writes one JSON file per fenced json block of a usage document's `## Exports` section.
// Usage: node extract-exports.mjs <document> <machine> <out-dir>
// Output: <out-dir>/<machine>--<repo>.json, the repo taken from the block's <summary> file name.
// Exit codes: 0 written, 1 a block is not valid JSON or has no summary, 2 bad usage.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const EXIT_BAD_INPUT = 1;
const EXIT_BAD_USAGE = 2;

const [doc, machine, outDir] = process.argv.slice(2);
if (!doc || !machine || !outDir) {
  console.error(
    'usage: node extract-exports.mjs <document> <machine> <out-dir>',
  );
  process.exit(EXIT_BAD_USAGE);
}
const lines = readFileSync(doc, 'utf8').split('\n');
const start = lines.findIndex((line) => /^## Exports\s*$/.test(line));
if (start < 0) {
  console.error('extract-exports: no "## Exports" section');
  process.exit(EXIT_BAD_INPUT);
}
mkdirSync(outDir, { recursive: true });
let repo = null;
let fence = null;
let count = 0;
for (let i = start + 1; i < lines.length; i++) {
  const line = lines[i];
  if (fence === null) {
    const summaryMatch = /^<summary>(.+)\.json<\/summary>\s*$/.exec(line);
    if (summaryMatch) repo = summaryMatch[1];
    else if (/^```json\s*$/.test(line)) fence = [];
  } else if (/^```\s*$/.test(line)) {
    if (!repo) {
      console.error(
        `extract-exports: json fence at line ${i + 1} has no summary`,
      );
      process.exit(EXIT_BAD_INPUT);
    }
    let parsed;
    try {
      parsed = JSON.parse(fence.join('\n'));
    } catch (error) {
      console.error(`extract-exports: ${repo}: ${error.message}`);
      process.exit(EXIT_BAD_INPUT);
    }
    writeFileSync(
      join(outDir, `${machine}--${repo}.json`),
      JSON.stringify(parsed, null, 2) + '\n',
    );
    console.log(`${machine}--${repo}.json`);
    count++;
    fence = null;
    repo = null;
  } else fence.push(line);
}
console.log(`${count} exports`);
