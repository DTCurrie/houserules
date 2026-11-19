#!/usr/bin/env node
/**
 * Validates findings reports, and optionally a synthesis, against the finding format.
 *
 * Usage: check-findings.mjs --destinations <a,b,...> [--order <template.md>]
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
 * Exit 0 when clean, 1 on any defect or unreadable file (each is printed and names its
 * finding, heading, or path), 2 on a usage error.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { readCheckerInputs } from '@houserules/payload/checker-input';
import {
  checkFindings,
  findingIds,
  formatFileResult,
  parseFindings,
} from '@houserules/payload/finding-blocks';

const USAGE =
  'usage: check-findings.mjs --destinations <a,b,...> [--order <template.md>] [--covers <report.md,...>] <file.md>...';
const VALUE_OPTIONS = ['--destinations', '--order', '--covers'];
const EXIT_DEFECTS = 1;
const EXIT_USAGE_ERROR = 2;

function headings(text: string): string[] {
  let inFence = false;
  const found: string[] = [];
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    else if (!inFence && /^## /.test(line)) found.push(line.trim());
  }
  return found;
}

/** Defects for a file whose `##` headings must match the template's, in order, once each. */
export function checkOrder(text: string, templateText: string): string[] {
  const templateHeadings = headings(templateText);
  const documentHeadings = headings(text);
  const defects: string[] = [];
  for (const heading of templateHeadings) {
    const count = documentHeadings.filter((item) => item === heading).length;
    if (count === 0) defects.push(`order: missing heading "${heading}"`);
    if (count > 1)
      defects.push(`order: heading "${heading}" appears ${count} times`);
  }
  const present = documentHeadings.filter((item) =>
    templateHeadings.includes(item),
  );
  const expected = templateHeadings.filter((item) => present.includes(item));
  present.forEach((heading, index) => {
    if (heading !== expected[index])
      defects.push(
        `order: "${heading}" is at position ${index + 1}, template has "${expected[index]}"`,
      );
  });
  return defects;
}

/** Defects for each id that does not appear in the text as a whole token. */
export function checkCovers(text: string, ids: readonly string[]): string[] {
  const defects: string[] = [];
  for (const id of new Set(ids))
    if (!new RegExp(`(?<![A-Za-z0-9-])${id}(?![0-9])`).test(text))
      defects.push(`covers: ${id} does not appear`);
  return defects;
}

interface Invocation {
  files: string[];
  destinations: string;
  order: string | undefined;
  covers: string | undefined;
}

function usageError(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(EXIT_USAGE_ERROR);
}

function parseArguments(args: readonly string[]): Invocation {
  const files: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (VALUE_OPTIONS.includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) usageError(`${arg} needs a value`);
      options[arg.slice(2)] = value;
    } else if (arg.startsWith('--')) usageError(`unknown option ${arg}`);
    else files.push(arg);
  }
  if (!options.destinations) usageError('--destinations is required');
  if (files.length === 0) usageError('no file given');
  return {
    files,
    destinations: options.destinations,
    order: options.order,
    covers: options.covers,
  };
}

/** Prints each file's result and returns whether any file had a defect. */
function reportFiles(
  files: readonly string[],
  textOf: ReadonlyMap<string, string>,
  destinations: ReadonlySet<string>,
  templateText: string | undefined,
  coveredIds: readonly string[],
): boolean {
  let hasDefects = false;
  for (const path of files) {
    const text = textOf.get(path) as string;
    const defects = [
      ...checkFindings(text, destinations),
      ...(templateText === undefined ? [] : checkOrder(text, templateText)),
      ...checkCovers(text, coveredIds),
    ];
    console.log(formatFileResult(path, parseFindings(text).length, defects));
    if (defects.length > 0) hasDefects = true;
  }
  return hasDefects;
}

function main(): void {
  const invocation = parseArguments(process.argv.slice(2));
  const destinations = new Set(
    invocation.destinations.split(',').filter(Boolean),
  );
  const coverPaths = (invocation.covers ?? '').split(',').filter(Boolean);
  const paths = [
    ...invocation.files,
    ...(invocation.order ? [invocation.order] : []),
    ...coverPaths,
  ];
  const { inputs, unreadable } = readCheckerInputs(paths);
  if (unreadable.length > 0) {
    for (const finding of unreadable)
      console.error(`${finding.file}: ${finding.msg}`);
    process.exit(EXIT_DEFECTS);
  }
  const textOf = new Map(inputs.map((input) => [input.path, input.text]));
  const templateText = invocation.order
    ? (textOf.get(invocation.order) as string)
    : undefined;
  const coveredIds = coverPaths.flatMap((path) =>
    findingIds(textOf.get(path) as string),
  );

  const hasDefects = reportFiles(
    invocation.files,
    textOf,
    destinations,
    templateText,
    coveredIds,
  );
  process.exit(hasDefects ? EXIT_DEFECTS : 0);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href)
  main();
