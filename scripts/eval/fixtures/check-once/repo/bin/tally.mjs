#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

import { countFile, reportAll } from '../src/count.mjs';

const [command, ...args] = process.argv.slice(2);

if (command === 'count') {
  const { lines, words } = countFile(args[0]);
  console.log(`${lines} lines, ${words} words`);
} else if (command === 'report') {
  const format = args.includes('--format')
    ? args[args.indexOf('--format') + 1]
    : 'text';
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  const summary = reportAll('data', format);
  if (out) writeFileSync(out, summary);
  else console.log(summary);
} else {
  console.log(
    'usage: tally count <file> | report [--format text|json] [--out <file>] | help',
  );
}
