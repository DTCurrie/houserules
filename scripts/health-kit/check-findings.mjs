#!/usr/bin/env node
/**
 * Validates findings reports, and optionally a synthesis, against FORMAT.md.
 *
 * Usage: node check-findings.mjs --destinations <a,b,...> [--order <template.md>]
 * [--covers <report.md,report.md,...>] <file.md>...
 *
 * `--destinations` is required. It lists the values a `destination` field may hold, for
 * example `phase-3,phase-4,none`. `none` is the value that pairs with `backlog`, `park`,
 * and `reject`, and every other listed value pairs with `fix-now` and `adopt`.
 *
 * Every positional file gets the block checks. `--order` and `--covers` also apply to each
 * positional file, so pass the synthesis alone when using them.
 *
 * `--order <template.md>`: each positional file must hold the template's `##` headings in
 * the template's order, with none missing and none repeated. Other `##` headings are ignored.
 *
 * `--covers <reports>`: every `### XX-NN` finding id in the listed reports must appear in
 * each positional file as a whole token.
 *
 * Exit 0 when clean, 1 on any defect (each is printed and names its finding or heading),
 * 2 on a usage error.
 */
import { readFileSync } from 'node:fs';

const TAGS = new Set(['quality', 'efficiency']);
const ACTIONS = new Set(['fix-now', 'adopt', 'backlog', 'park', 'reject']);
const PHASE_ACTIONS = new Set(['fix-now', 'adopt']);
const REQUIRED = [
  'tag',
  'surface',
  'evidence',
  'version gate',
  'candidate action',
  'destination',
  'cost',
];
const USAGE =
  'usage: check-findings.mjs --destinations <a,b,...> [--order <template.md>] [--covers <report.md,...>] <file.md>...';

function usageError(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

const files = [];
const options = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (['--destinations', '--order', '--covers'].includes(arg)) {
    const value = args[++index];
    if (!value || value.startsWith('--')) usageError(`${arg} needs a value`);
    options[arg.slice(2)] = value;
  } else if (arg.startsWith('--')) usageError(`unknown option ${arg}`);
  else files.push(arg);
}
if (!options.destinations) usageError('--destinations is required');
if (files.length === 0) usageError('no file given');
const DESTINATIONS = new Set(options.destinations.split(',').filter(Boolean));

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    return usageError(`cannot read ${path}: ${error.code}`);
  }
}

function headings(text) {
  let inFence = false;
  const found = [];
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    else if (!inFence && /^## /.test(line)) found.push(line.trim());
  }
  return found;
}

function findingIds(text) {
  return [...text.matchAll(/^### ([A-Z]{2}-\d{2}) /gm)].map(
    (match) => match[1],
  );
}

const templateHeadings = options.order ? headings(read(options.order)) : [];
const coveredIds = (options.covers ?? '')
  .split(',')
  .filter(Boolean)
  .flatMap((report) => findingIds(read(report)));

let failed = false;
for (const path of files) {
  const text = read(path);
  const blocks = text.split(/^### (?=[A-Z]{2}-\d{2} )/m).slice(1);
  const defects = [];
  const ids = [];
  for (const block of blocks) {
    const id = block.slice(0, 5);
    ids.push(id);
    const fields = new Map();
    for (const match of block.matchAll(/^- \*\*([a-z ]+):\*\* (.*)$/gm)) {
      const key = match[1];
      fields.set(key, [...(fields.get(key) ?? []), match[2].trim()]);
    }
    for (const key of REQUIRED)
      if (!fields.has(key)) defects.push(`${id}: missing ${key}`);
    const tag = fields.get('tag')?.[0];
    if (tag !== undefined && !TAGS.has(tag))
      defects.push(`${id}: tag "${tag}"`);
    const action = fields.get('candidate action')?.[0];
    if (action !== undefined && !ACTIONS.has(action))
      defects.push(`${id}: candidate action "${action}"`);
    const destination = fields.get('destination')?.[0];
    if (destination !== undefined && !DESTINATIONS.has(destination))
      defects.push(`${id}: destination "${destination}"`);
    if (ACTIONS.has(action) && DESTINATIONS.has(destination)) {
      const namesPhase = destination !== 'none';
      if (PHASE_ACTIONS.has(action) && !namesPhase)
        defects.push(`${id}: ${action} must name a phase, not none`);
      if (!PHASE_ACTIONS.has(action) && namesPhase)
        defects.push(`${id}: ${action} must name none, not ${destination}`);
    }
    for (const line of fields.get('evidence') ?? [])
      if (!/https?:\/\//.test(line) && !/`[^`]+`/.test(line))
        defects.push(
          `${id}: evidence has no URL and no command: ${line.slice(0, 60)}`,
        );
  }
  ids.forEach((id, index) => {
    const expected = String(index + 1).padStart(2, '0');
    if (id.slice(3) !== expected)
      defects.push(
        `${id}: numbering gap, expected ${id.slice(0, 3)}${expected}`,
      );
  });
  if (blocks.length === 0 && !/zero findings|no findings/i.test(text))
    defects.push('no findings and no statement of why');

  if (options.order) {
    const own = headings(text);
    for (const heading of templateHeadings) {
      const count = own.filter((item) => item === heading).length;
      if (count === 0) defects.push(`order: missing heading "${heading}"`);
      if (count > 1)
        defects.push(`order: heading "${heading}" appears ${count} times`);
    }
    const present = own.filter((item) => templateHeadings.includes(item));
    const expected = templateHeadings.filter((item) => present.includes(item));
    present.forEach((heading, index) => {
      if (heading !== expected[index])
        defects.push(
          `order: "${heading}" is at position ${index + 1}, template has "${expected[index]}"`,
        );
    });
  }
  for (const id of new Set(coveredIds))
    if (!new RegExp(`(?<![A-Za-z0-9-])${id}(?![0-9])`).test(text))
      defects.push(`covers: ${id} does not appear`);

  console.log(
    `${path}: ${blocks.length} finding(s), ${defects.length} defect(s)`,
  );
  for (const defect of defects) console.log(`  ${defect}`);
  if (defects.length > 0) failed = true;
}
process.exit(failed ? 1 : 0);
