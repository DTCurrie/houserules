#!/usr/bin/env node
/**
 * Fetches a list of URLs concurrently, writes each body to a file, and prints one line per
 * URL. Page content is never printed, so a batch costs the caller a few lines of context.
 *
 * Usage:
 *   fetch-batch.mjs --out <dir> [--max-urls <n>] [--timeout <ms>] [--max-bytes <n>] [--raw] <url>...
 *
 * Options:
 *   --out <dir>        directory for the files, created when missing. Required.
 *   --max-urls <n>     most URLs one call accepts (default 20).
 *   --timeout <ms>     per-URL limit covering the request and the body (default 20000).
 *   --max-bytes <n>    per-page byte cap, the body is cut there (default 2097152).
 *   --raw              keep HTML as received and skip the Markdown conversion.
 *
 * Each body is written to `<dir>/<n>-<host>.<ext>`, `n` being the 1-based input position.
 * A 2xx HTML response also gets `<dir>/<n>-<host>.md` unless `--raw` is set, and beside it
 * `<dir>/<n>-<host>.outline.txt`. The outline has one tab-separated line per heading, `h<level>`,
 * its line number in the Markdown, then the text. A page with no heading gets one line,
 * `no headings`, then the Markdown's line count. The Markdown comes from the repo's own
 * `turndown`, resolved from the working directory. Only `<main>`, else `<article>`, else the
 * body is converted, parsed by the DOM parser `turndown` carries, with script, style, nav,
 * header, footer, aside, noscript, svg, form, button and iframe removed. When `turndown`
 * cannot be resolved this exits 1 before any request and prints the install command.
 * A non-2xx response keeps its raw body, gets no Markdown or outline, and is marked failed.
 *
 * Output, one tab-separated line per URL in input order:
 *   <n> <status> <bytes> <content-type> <path> [words=<count>] [truncated] [failed]
 *   <n> error <url> <message>
 * `path` is the Markdown file for converted HTML, otherwise the raw file. `words` is the
 * Markdown's word count and appears only on a converted line.
 *
 * Exit 0 when at least one URL returned a 2xx response, 1 when none did or the converter
 * is missing, 2 on a usage error. One failing URL never fails the batch.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  CONVERTER_INSTALL_LINES,
  loadConverter,
  type MarkdownConverter,
} from '@houserules/payload/html-markdown';

const DEFAULT_MAX_URLS = 20;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const EXIT_NO_SUCCESS = 1;
const EXIT_USAGE_ERROR = 2;
const FETCHABLE_PROTOCOLS = new Set(['http:', 'https:']);

const USAGE =
  'usage: fetch-batch.mjs --out <dir> [--max-urls <n>] [--timeout <ms>] [--max-bytes <n>] [--raw] <url>...';

const EXTENSIONS: [RegExp, string][] = [
  [/html/, 'html'],
  [/json/, 'json'],
  [/pdf/, 'pdf'],
  [/^text\//, 'txt'],
];

const HEADING_LINE = /^(#{1,6}) (.+)$/;

interface Outcome {
  index: number;
  line: string;
  isSuccess: boolean;
}

function usageError(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(EXIT_USAGE_ERROR);
}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    usageError(`${name} must be a positive integer, got "${value}".`);
  return parsed;
}

function extensionFor(contentType: string): string {
  const type = contentType.toLowerCase();
  return EXTENSIONS.find(([pattern]) => pattern.test(type))?.[1] ?? 'bin';
}

function fileStem(index: number, url: URL): string {
  const host = url.hostname.replace(/[^a-z0-9.-]/gi, '_');
  return `${index}-${host}`;
}

function countWords(markdown: string): number {
  return markdown.split(/\s+/).filter(Boolean).length;
}

/** One line per heading, `h<level>`, line number in the Markdown, then the text. */
function outlineOf(markdown: string): string {
  const lines = markdown.split('\n');
  const headings = lines.flatMap((line, position) => {
    const match = HEADING_LINE.exec(line);
    return match ? [`h${match[1]?.length}\t${position + 1}\t${match[2]}`] : [];
  });
  if (headings.length === 0) return `no headings\t${lines.length} lines\n`;
  return `${headings.join('\n')}\n`;
}

/**
 * Reads the response body, stopping once `maxBytes` have arrived.
 *
 * @returns The bytes kept, cut at the cap, and whether the cap cut the body.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ body: Buffer; wasTruncated: boolean }> {
  if (!response.body) return { body: Buffer.alloc(0), wasTruncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let wasTruncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > maxBytes) {
      wasTruncated = true;
      await reader.cancel();
      break;
    }
  }
  return { body: Buffer.concat(chunks).subarray(0, maxBytes), wasTruncated };
}

async function fetchOne(
  index: number,
  rawUrl: string,
  options: {
    out: string;
    timeoutMs: number;
    maxBytes: number;
    convert: MarkdownConverter | null;
  },
): Promise<Outcome> {
  try {
    const url = new URL(rawUrl);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const contentType = response.headers.get('content-type') ?? 'unknown';
    const { body, wasTruncated } = await readCapped(response, options.maxBytes);
    const stem = join(options.out, fileStem(index, url));
    const path = `${stem}.${extensionFor(contentType)}`;
    writeFileSync(path, body);
    const fields: (string | number)[] = [
      index,
      response.status,
      body.length,
      contentType,
    ];
    if (options.convert && response.ok && /html/i.test(contentType))
      fields.push(...writeConvertedFiles(stem, body, options.convert));
    else fields.push(path);
    if (wasTruncated) fields.push('truncated');
    if (!response.ok) fields.push('failed');
    return { index, line: fields.join('\t'), isSuccess: response.ok };
  } catch (error) {
    return {
      index,
      line: [index, 'error', rawUrl, describeFailure(error)].join('\t'),
      isSuccess: false,
    };
  }
}

/**
 * Writes the Markdown and its outline beside the raw file.
 *
 * @returns The line fields for the Markdown path and its word count.
 */
function writeConvertedFiles(
  stem: string,
  body: Buffer,
  convert: MarkdownConverter,
): string[] {
  const markdown = convert(body.toString('utf8'));
  const path = `${stem}.md`;
  writeFileSync(path, markdown);
  writeFileSync(`${stem}.outline.txt`, outlineOf(markdown));
  return [path, `words=${countWords(markdown)}`];
}

/** The error message, with its cause's message appended when there is one. */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause;
  return cause instanceof Error ? `${message}: ${cause.message}` : message;
}

interface BatchOptions {
  out: string;
  urls: string[];
  timeoutMs: number;
  maxBytes: number;
  isRaw: boolean;
}

/** Parses and validates the command line, exiting with a usage error before any request. */
function parseOptions(): BatchOptions {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: 'string' },
        'max-urls': { type: 'string' },
        timeout: { type: 'string' },
        'max-bytes': { type: 'string' },
        raw: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals: urls } = parsed;
  if (!values.out) usageError('--out is required.');
  if (urls.length === 0) usageError('Give at least one URL.');
  const maxUrls = values['max-urls']
    ? positiveInteger('--max-urls', values['max-urls'])
    : DEFAULT_MAX_URLS;
  const timeoutMs = values.timeout
    ? positiveInteger('--timeout', values.timeout)
    : DEFAULT_TIMEOUT_MS;
  const maxBytes = values['max-bytes']
    ? positiveInteger('--max-bytes', values['max-bytes'])
    : DEFAULT_MAX_BYTES;
  if (urls.length > maxUrls)
    usageError(`Got ${urls.length} URLs, the limit is ${maxUrls}.`);
  assertFetchableUrls(urls);
  return { out: values.out, urls, timeoutMs, maxBytes, isRaw: values.raw };
}

/** Exits with a usage error on the first URL that does not parse or is not http(s). */
function assertFetchableUrls(urls: readonly string[]): void {
  for (const url of urls) {
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      usageError(`Not a valid URL: ${url}`);
    }
    if (!FETCHABLE_PROTOCOLS.has(protocol))
      usageError(`Only http: and https: URLs are fetched, got ${url}`);
  }
}

/** The host's `turndown`, or an exit with the install command when it cannot be resolved. */
function requireConverter(): MarkdownConverter {
  const convert = loadConverter();
  if (convert) return convert;
  console.error(
    [
      'fetch-batch needs the repo\'s own "turndown" to convert HTML to Markdown, and it is not installed.',
      ...CONVERTER_INSTALL_LINES,
      'Or pass --raw to skip the conversion.',
    ].join('\n'),
  );
  process.exit(EXIT_NO_SUCCESS);
}

async function main(): Promise<void> {
  const { out, urls, timeoutMs, maxBytes, isRaw } = parseOptions();
  const convert = isRaw ? null : requireConverter();
  mkdirSync(out, { recursive: true });
  const outcomes = await Promise.all(
    urls.map((url, position) =>
      fetchOne(position + 1, url, { out, timeoutMs, maxBytes, convert }),
    ),
  );
  for (const outcome of outcomes) console.log(outcome.line);
  process.exit(
    outcomes.some((outcome) => outcome.isSuccess) ? 0 : EXIT_NO_SUCCESS,
  );
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href)
  await main();
