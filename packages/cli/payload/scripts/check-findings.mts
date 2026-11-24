#!/usr/bin/env node
/**
 * Validates findings reports, and optionally a synthesis, against the finding format.
 *
 * Usage: check-findings.mjs --destinations <a,b,...> [--order <template.md>]
 * [--covers <report.md,report.md,...>]
 * [--verify-urls [--max-urls <n>] [--timeout <ms>]] <file.md>...
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
 * `--verify-urls`: fetch each distinct URL cited in an evidence line shaped
 * `<URL> → "<quote>"` once, and report each quote the page text lacks. Pages are converted
 * to Markdown with the host's own `turndown`, and only `<main>`, else `<article>`, else the
 * body is searched. The `content-type` header decides what is HTML: `text/html` and
 * `application/xhtml+xml` are converted, any other type is searched as plain text and never
 * converted, and only a response with no content type is sniffed for a leading `<!doctype html`
 * or `<html`. A quote may hold backslash-escaped quotes (`\"`). The quote and the page text
 * pass through one normalizer that unwraps inline Markdown, drops table pipes, and unescapes
 * backslashes. The normalizer also drops U+200B and U+2061 to U+2064. Before conversion, a
 * footnote reference (a `<sup>` holding only an in-page link) is dropped and a LaTeXML `<math>`
 * element is replaced by its `alttext`, while an exponent `<sup>` stays. A quote not found prints
 * its first 60 characters, with an ellipsis when cut. A quote not found whose text minus trailing
 * `.,;:!?` is found prints "ends with punctuation the source lacks" and still counts as not found.
 * Without `turndown` it prints the install command and exits 1 before any request.
 * An unreachable URL (network error, timeout, or non-2xx status) is reported as unreachable and
 * never as a failed quote. A page the converter throws on is reported as unconvertible, counted
 * apart from unreachable, and exits 1.
 * `--max-urls <n>` (default 200) skips URLs past the cap, and `--timeout <ms>` (default 15000)
 * bounds each fetch. Both only apply with `--verify-urls`. Without the flag no network call is made.
 *
 * Exit 0 when clean, 1 on any defect or unreadable file (each is printed and names its
 * finding, heading, or path), 2 on a usage error.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { readCheckerInputs } from '@houserules/payload/checker-input';
import {
  CONVERTER_INSTALL_LINES,
  loadConverter,
  type MarkdownConverter,
} from '@houserules/payload/html-markdown';
import {
  checkFindings,
  findingIds,
  formatFileResult,
  parseFindings,
} from '@houserules/payload/finding-blocks';

const USAGE =
  'usage: check-findings.mjs --destinations <a,b,...> [--order <template.md>] [--covers <report.md,...>] [--verify-urls [--max-urls <n>] [--timeout <ms>]] <file.md>...';
const VALUE_OPTIONS = [
  '--destinations',
  '--order',
  '--covers',
  '--max-urls',
  '--timeout',
];
const DEFAULT_MAX_URLS = 200;
const DEFAULT_TIMEOUT_MS = 15000;
const FETCH_CONCURRENCY = 6;
const SUCCESS_STATUS_MIN = 200;
const SUCCESS_STATUS_MAX = 299;
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

const INVISIBLE_CHARACTERS = /[\u200b\u2061-\u2064]/g;

/** Folds curly quotes and dashes to ASCII, collapses whitespace, and lowercases. */
function normalizeText(text: string): string {
  return text
    .replace(INVISIBLE_CHARACTERS, '')
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Drops the Markdown that a converted page carries and a prose quote does not. */
function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!>|"'<~])/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, '')
    .replace(/[ \t]*\|[ \t]*/g, ' ');
}

/** The one normalizer both the cited quote and the page text pass through. */
function normalizeForMatch(text: string): string {
  return normalizeText(stripMarkdown(text));
}

const HTML_CONTENT_TYPE = /\b(?:text\/html|application\/xhtml\+xml)\b/i;
const HTML_BODY_START = /^\s*(?:<!doctype html|<html)/i;

function isHtmlPage(body: string, contentType: string): boolean {
  if (contentType.trim() === '') return HTML_BODY_START.test(body);
  return HTML_CONTENT_TYPE.test(contentType);
}

const FOOTNOTE_REFERENCE =
  /<sup\b[^>]*>\s*<a\b[^>]*\bhref\s*=\s*["']#[^"']*["'][^>]*>[^<]*<\/a>\s*<\/sup>/gi;
const MATH_WITH_ALTTEXT =
  /<math\b[^>]*?\balttext\s*=\s*"([^"]*)"[^>]*>[\s\S]*?<\/math>/gi;

/**
 * Drops footnote references (a `<sup>` holding only an in-page link) and replaces each LaTeXML
 * `<math>` element with its `alttext`. An exponent `<sup>` stays, since quotes keep it.
 */
function simplifyMarkup(html: string): string {
  return html
    .replace(FOOTNOTE_REFERENCE, '')
    .replace(MATH_WITH_ALTTEXT, (_match, alttext: string) => ` ${alttext} `);
}

/**
 * Page text for the quote search. Only a page the content type marks as HTML goes through the
 * converter, which may throw. Every page then loses its Markdown markup.
 */
export function pageText(
  body: string,
  contentType: string,
  convert: MarkdownConverter,
): string {
  if (!isHtmlPage(body, contentType)) return normalizeForMatch(body);
  return normalizeForMatch(convert(simplifyMarkup(body)));
}

interface CitedQuote {
  file: string;
  id: string;
  url: string;
  quote: string;
}

const CITATION = /(https?:\/\/[^\s"→]+)\s*→\s*"((?:[^"\\]|\\.)+)"/g;

/** Every `<URL> → "<quote>"` pair in the evidence lines of each file. */
function collectCitations(
  files: readonly string[],
  textOf: ReadonlyMap<string, string>,
): CitedQuote[] {
  const cited: CitedQuote[] = [];
  for (const file of files)
    for (const finding of parseFindings(textOf.get(file) as string))
      for (const line of finding.fields.get('evidence') ?? [])
        for (const match of line.matchAll(CITATION))
          cited.push({
            file,
            id: finding.id,
            url: match[1] as string,
            quote: match[2] as string,
          });
  return cited;
}

type PageResult =
  { text: string } | { unreachable: string } | { unconvertible: string };

/** Why a fetch threw: `timeout`, the network cause's code, or the error message. */
function describeFetchFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError') return 'timeout';
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    cause && typeof cause === 'object' && 'code' in cause
      ? String(cause.code)
      : undefined;
  return code ?? (error instanceof Error ? error.message : 'error');
}

async function fetchPage(
  url: string,
  timeoutMs: number,
  convert: MarkdownConverter,
): Promise<PageResult> {
  let body: string;
  let contentType: string;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (
      response.status < SUCCESS_STATUS_MIN ||
      response.status > SUCCESS_STATUS_MAX
    )
      return { unreachable: `status ${response.status}` };
    body = await response.text();
    contentType = response.headers.get('content-type') ?? '';
  } catch (error) {
    return { unreachable: describeFetchFailure(error) };
  }
  try {
    return { text: pageText(body, contentType, convert) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { unconvertible: message.replace(/\s+/g, ' ') };
  }
}

/** Fetches each URL with at most FETCH_CONCURRENCY requests in flight. */
async function fetchAll(
  urls: readonly string[],
  timeoutMs: number,
  convert: MarkdownConverter,
): Promise<Map<string, PageResult>> {
  const pages = new Map<string, PageResult>();
  let next = 0;
  async function worker(): Promise<void> {
    while (next < urls.length) {
      const url = urls[next++] as string;
      pages.set(url, await fetchPage(url, timeoutMs, convert));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, urls.length) }, worker),
  );
  return pages;
}

const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const QUOTE_START_LENGTH = 60;

/** The quoted start of a quote, cut to QUOTE_START_LENGTH characters with an ellipsis. */
function quoteStart(quote: string): string {
  const flat = quote.replace(/\s+/g, ' ').trim();
  return flat.length > QUOTE_START_LENGTH
    ? `"${flat.slice(0, QUOTE_START_LENGTH)}..."`
    : `"${flat}"`;
}

/**
 * Prints one line per unreachable citation and per quote missing from its page.
 *
 * @returns How many quotes were searched for, and how many of them were not found.
 */
function reportQuotes(
  cited: readonly CitedQuote[],
  pages: ReadonlyMap<string, PageResult>,
): { checked: number; notFound: number } {
  let checked = 0;
  let notFound = 0;
  const reported = new Set<string>();
  for (const item of cited) {
    const page = pages.get(item.url);
    if (!page) continue;
    if ('unreachable' in page || 'unconvertible' in page) {
      const key = `${item.file}\0${item.id}\0${item.url}`;
      if (reported.has(key)) continue;
      reported.add(key);
      console.log(
        'unreachable' in page
          ? `${item.file}: ${item.id}: unreachable ${item.url} (${page.unreachable})`
          : `${item.file}: ${item.id}: unconvertible ${item.url} (${page.unconvertible})`,
      );
      continue;
    }
    checked++;
    const wanted = normalizeForMatch(item.quote);
    if (page.text.includes(wanted)) continue;
    notFound++;
    const start = quoteStart(item.quote);
    const trimmed = wanted.replace(TRAILING_PUNCTUATION, '');
    if (trimmed !== wanted && trimmed !== '' && page.text.includes(trimmed))
      console.log(
        `${item.file}: ${item.id}: quote ends with punctuation the source lacks at ${item.url}: ${start}`,
      );
    else
      console.log(
        `${item.file}: ${item.id}: quote not found at ${item.url}: ${start}`,
      );
  }
  return { checked, notFound };
}

/** Fetches each cited URL once, prints the verification lines and summary, and reports a missing quote. */
async function verifyUrls(
  files: readonly string[],
  textOf: ReadonlyMap<string, string>,
  maxUrls: number,
  timeoutMs: number,
  convert: MarkdownConverter,
): Promise<boolean> {
  const cited = collectCitations(files, textOf);
  const distinct = [...new Set(cited.map((item) => item.url))];
  const toFetch = distinct.slice(0, maxUrls);
  const skipped = distinct.length - toFetch.length;
  const pages = await fetchAll(toFetch, timeoutMs, convert);
  const { checked, notFound } = reportQuotes(cited, pages);
  const unreachable = [...pages.values()].filter(
    (page) => 'unreachable' in page,
  ).length;
  const unconvertible = [...pages.values()].filter(
    (page) => 'unconvertible' in page,
  ).length;
  console.log(
    `verify-urls: ${toFetch.length} URL(s) fetched, ${checked} quote(s) checked, ${notFound} not found, ${unreachable} unreachable, ${unconvertible} unconvertible, ${skipped} skipped past the cap`,
  );
  return notFound > 0 || unconvertible > 0;
}

interface Invocation {
  files: string[];
  shouldVerifyUrls: boolean;
  maxUrls: number;
  timeoutMs: number;
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
  let shouldVerifyUrls = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (VALUE_OPTIONS.includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) usageError(`${arg} needs a value`);
      options[arg.slice(2)] = value;
    } else if (arg === '--verify-urls') shouldVerifyUrls = true;
    else if (arg.startsWith('--')) usageError(`unknown option ${arg}`);
    else files.push(arg);
  }
  if (!options.destinations) usageError('--destinations is required');
  if (files.length === 0) usageError('no file given');
  const maxUrls = Number(options['max-urls'] ?? DEFAULT_MAX_URLS);
  const timeoutMs = Number(options.timeout ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(maxUrls) || maxUrls < 0)
    usageError('--max-urls needs a non-negative integer');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    usageError('--timeout needs a positive integer');
  return {
    files,
    shouldVerifyUrls,
    maxUrls,
    timeoutMs,
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

/** The host's `turndown`, or an exit with the install command when it cannot be resolved. */
function requireConverter(): MarkdownConverter {
  const convert = loadConverter();
  if (convert) return convert;
  console.error(
    [
      'check-findings --verify-urls needs the repo\'s own "turndown" to read fetched pages, and it is not installed.',
      ...CONVERTER_INSTALL_LINES,
    ].join('\n'),
  );
  process.exit(EXIT_DEFECTS);
}

async function main(): Promise<void> {
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
  const convert = invocation.shouldVerifyUrls ? requireConverter() : null;
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
  const quotesMissing = convert
    ? await verifyUrls(
        invocation.files,
        textOf,
        invocation.maxUrls,
        invocation.timeoutMs,
        convert,
      )
    : false;
  process.exit(hasDefects || quotesMissing ? EXIT_DEFECTS : 0);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href)
  await main();
