#!/usr/bin/env node
/**
 * WCAG criterion lookup and change-to-criteria router.
 *
 * Usage:
 *   wcag.mjs lookup <criterion|keyword>   resolve one criterion, or list candidates for a keyword
 *   wcag.mjs applies <file>...            which criteria the given markup files are subject to
 *   wcag.mjs patterns                     print the whole routing table
 *
 * `lookup` reads the criterion corpus installed at .claude/reference/wcag22.md and prints one
 * entry, either by number ("1.4.3") or by a case-insensitive match against criterion names.
 *
 * `applies` reads each file, matches it against lib/wcag-patterns.mjs's routing table, and
 * prints which patterns fired and which criteria they imply. The table routes, it does not
 * lint: a named criterion may not actually apply, and this never judges whether the markup
 * satisfies one. It only says which criteria are worth reading.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { repoRoot } from '@agent-kit/cli/payload/kit-config';
import {
  matchPatterns,
  criteriaFor,
  MARKUP_PATTERNS,
  type PatternHit,
} from './lib/wcag-patterns.mjs';

interface Criterion {
  number: string;
  name: string;
  level: string;
  url: string;
  body: string;
}

const OVER_INCLUSION_NOTE =
  'This router is deliberately loose: a named criterion may not apply, and it never judges whether the markup satisfies one.';

function usage(): void {
  console.error(
    [
      'Usage:',
      '  wcag.mjs lookup <criterion|keyword>   resolve one criterion, or list candidates for a keyword',
      '  wcag.mjs applies <file>...            which criteria the given markup files are subject to',
      '  wcag.mjs patterns                     print the whole routing table',
    ].join('\n'),
  );
}

function corpusPath(): string {
  return resolve(repoRoot(), '.claude/reference/wcag22.md');
}

function loadCorpus(): Criterion[] | undefined {
  const path = corpusPath();
  if (!existsSync(path)) {
    console.error(
      `No WCAG corpus at ${path}. The accessibility module installs it, run \`npx agent-kit init\` or \`update\` to add it.`,
    );
    return undefined;
  }
  const text = readFileSync(path, 'utf8');
  return parseCorpus(text);
}

/** Splits the corpus on `## <number> <name>` headings into one entry per criterion. */
function parseCorpus(text: string): Criterion[] {
  const entries: Criterion[] = [];
  const headingRe = /^## (\d+\.\d+\.\d+) (.+)$/gm;
  const matches = [...text.matchAll(headingRe)];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const next = matches[i + 1];
    const start = match.index + match[0].length;
    const end = next ? next.index : text.length;
    const rest = text.slice(start, end).trim();
    const metaMatch = rest.match(/^\*\*Level (\w+)\*\*.*?(https:\/\/\S+)/);
    const level = metaMatch?.[1] ?? '?';
    const url = metaMatch?.[2] ?? '';
    entries.push({
      number: match[1],
      name: match[2].trim(),
      level,
      url,
      body: rest,
    });
  }
  return entries;
}

function printEntry(entry: Criterion): void {
  console.log(`## ${entry.number} ${entry.name}\n`);
  console.log(entry.body);
}

function renderCandidates(matches: Criterion[]): void {
  for (const entry of matches) {
    console.log(`${entry.number} ${entry.name} (${entry.level})`);
  }
}

function runLookup(query: string | undefined, entries: Criterion[]): number {
  if (!query) {
    usage();
    return 1;
  }
  const byNumber = entries.find((e) => e.number === query);
  if (byNumber) {
    printEntry(byNumber);
    return 0;
  }
  const isCriterionShaped = /^\d+\.\d+\.\d+$/.test(query);
  const needle = query.toLowerCase();
  const matches = entries.filter((e) => e.name.toLowerCase().includes(needle));
  if (matches.length === 1) {
    printEntry(matches[0]);
    return 0;
  }
  if (matches.length > 1) {
    renderCandidates(matches);
    return 0;
  }
  console.error(
    isCriterionShaped
      ? `No criterion ${query} in the corpus. Try \`wcag.mjs patterns\` or a keyword search.`
      : `No criterion name matches "${query}". Try \`wcag.mjs patterns\` or a different keyword.`,
  );
  return 1;
}

function runApplies(files: string[]): number {
  if (files.length === 0) {
    usage();
    return 1;
  }
  let readCount = 0;
  const allHits: PatternHit[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      console.log(`${file}: unreadable, skipping.`);
      continue;
    }
    readCount += 1;
    const hits = matchPatterns(source);
    if (hits.length === 0) {
      console.log(`${file}: no patterns matched.`);
      continue;
    }
    console.log(`${file}:`);
    for (const hit of hits) {
      console.log(
        `  ${hit.pattern.id}  ${hit.pattern.label}  x${hit.count}  -> ${hit.pattern.criteria.join(', ')}`,
      );
    }
    allHits.push(...hits);
  }
  if (readCount === 0) {
    console.error('No file could be read.');
    return 1;
  }
  const combined = criteriaFor(allHits);
  console.log(
    `\nCombined criteria: ${combined.length > 0 ? combined.join(', ') : 'none'}`,
  );
  console.log(OVER_INCLUSION_NOTE);
  return 0;
}

function runPatterns(): number {
  for (const pattern of MARKUP_PATTERNS) {
    console.log(
      `${pattern.id}  ${pattern.label}  ->  ${pattern.criteria.join(', ')}`,
    );
  }
  return 0;
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'lookup': {
    const entries = loadCorpus();
    if (!entries) process.exit(1);
    process.exit(runLookup(rest[0], entries));
    break;
  }
  case 'applies':
    process.exit(runApplies(rest));
    break;
  case 'patterns':
    process.exit(runPatterns());
    break;
  default:
    usage();
    process.exit(1);
}
