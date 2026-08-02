import { gzipSync, gunzipSync } from 'node:zlib';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';

import { ENTRY_HEAD } from './backlog-id.mjs';

export const SEPARATOR = '---';

const METADATA_SCAN_LINES = 8;
const TRANSCRIPT_TAIL_BYTES = 16384;
const METADATA_LINE = /^\*\*([A-Za-z][A-Za-z ]*):\*\*\s+(.+)$/;
const METADATA_JOIN = ' · ';

const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svelte-kit',
  'dist',
  'build',
  '.turbo',
]);

export const nowIso = () => new Date().toISOString();
export const todayDate = () => nowIso().slice(0, 10);

export const encodeBody = (s?: string) =>
  gzipSync(Buffer.from(s ?? '', 'utf8')).toString('base64');
export const decodeBody = (s: string) =>
  gunzipSync(Buffer.from(s, 'base64')).toString('utf8');

interface TranscriptRecord {
  sessionId?: string;
  timestamp?: string;
}

function readLastJsonRecord(file: string): TranscriptRecord | null {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return null;
    const chunkSize = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(chunkSize);
    readSync(fd, buf, 0, chunkSize, size - chunkSize);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        // Partial JSON at the buffer head, or a malformed line — keep walking back.
      }
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * The active Claude Code session, from `CLAUDE_SESSION_ID` or the freshest transcript tail.
 * Transcripts live at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where encoded-cwd
 * is the absolute repo path with `/` replaced by `-`. mtime alone is not reliable when several
 * sessions share one project at once, so this compares the last record's timestamp.
 *
 * @returns null in any harness that is not Claude Code, which callers report as `chat: null`.
 */
export function detectChatId(repoRoot: string): string | null {
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  const dir = resolve(
    homedir(),
    '.claude/projects',
    repoRoot.replaceAll('/', '-'),
  );
  if (!existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { ts: number; sessionId: string } | null = null;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const rec = readLastJsonRecord(resolve(dir, e.name));
    if (!rec?.sessionId || !rec?.timestamp) continue;
    const ts = Date.parse(rec.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (!best || ts > best.ts) best = { ts, sessionId: rec.sessionId };
  }
  return best?.sessionId ?? null;
}

/** Splices `--chat <id>` / `--chat=<id>` out of `argv` in place. */
export function takeChatFlag(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--chat') {
      const v = argv[i + 1];
      argv.splice(i, 2);
      return v ?? null;
    }
    if (a?.startsWith('--chat=')) {
      argv.splice(i, 1);
      return a.slice('--chat='.length) || null;
    }
  }
  return null;
}

/** `--chat=none` suppresses provenance. Any other flag wins over detection. */
export function resolveChat(
  flag: string | null,
  repoRoot: string,
): string | null {
  if (flag === 'none') return null;
  return flag ?? detectChatId(repoRoot);
}

export function appendEvent(
  logFile: string,
  record: Record<string, unknown>,
): void {
  appendFileSync(logFile, JSON.stringify(record) + '\n');
}

/** Every parseable record in log order. Unparseable lines are skipped, never fatal. */
export function readLog<TRecord>(logFile: string): TRecord[] {
  if (!existsSync(logFile)) return [];
  const out: TRecord[] = [];
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A truncated write or a hand-edit. One bad line must not blind the whole ledger.
    }
  }
  return out;
}

export function readSurface(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

export function ensureSurfaceHeader(file: string, header: string): void {
  if (existsSync(file)) return;
  writeFileSync(file, header);
}

/** Reads the body from the argument, or from stdin when it was omitted and stdin is a pipe. */
export function readContentArg(content: string | undefined): string {
  if (content !== undefined) return content;
  if (process.stdin.isTTY) return '';
  return readFileSync(0, 'utf8').trimEnd();
}

export function relativeToRoot(repoRoot: string, p: string): string {
  return relative(repoRoot, resolve(p));
}

/** Every surface file with this basename under `root`, skipping build and vendor dirs. */
export function findSurfaceFiles(root: string, filename: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIPPED_DIRS.has(e.name)) continue;
      const full = resolve(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name === filename) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** `**Label:** value` pairs on one line, which may carry several joined by ` · `. */
function metadataOf(line: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const segment of line.split(METADATA_JOIN)) {
    const m = segment.trim().match(METADATA_LINE);
    if (m) pairs.push([m[1], m[2].trim()]);
  }
  return pairs;
}

export function renderMetadata(fields: Record<string, string | null>): string {
  return Object.entries(fields)
    .filter(([, v]) => v)
    .map(([k, v]) => `**${k}:** ${v}`)
    .join('\n');
}

export interface EntryRange {
  start: number;
  end: number;
  meta: Record<string, string>;
  lines: string[];
}

/**
 * Locates one entry's line span in a rendered surface, plus the metadata in its header.
 *
 * The span ends at the next entry heading or the next standalone separator, whichever comes
 * first, and swallows one trailing blank line so removing an entry leaves no gap. A repeated
 * label within the header window resolves to the last occurrence.
 */
export function findEntryRange(text: string, id: string): EntryRange | null {
  const lines = text.split('\n');
  const meta: Record<string, string> = {};
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ENTRY_HEAD);
    if (m && m[1] === id) {
      start = i;
      const until = Math.min(i + METADATA_SCAN_LINES, lines.length);
      for (let j = i + 1; j < until; j++) {
        for (const [label, value] of metadataOf(lines[j])) meta[label] = value;
      }
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (ENTRY_HEAD.test(lines[i])) {
      end = i;
      break;
    }
    if (lines[i].trim() === SEPARATOR) {
      end = i + 1;
      break;
    }
  }
  while (end < lines.length && lines[end].trim() === '') end++;
  return { start, end, meta, lines };
}

export interface ParsedEntry {
  id: string;
  title: string;
  meta: Record<string, string>;
  body: string;
}

interface EntryDraft {
  id: string;
  title: string;
  meta: Record<string, string>;
  body: string[];
}

/**
 * Every entry in a rendered surface. A metadata line is consumed into `meta` rather than the
 * body, and the first occurrence of a label wins, so prose below the header that happens to
 * look like metadata cannot displace the real header value.
 */
export function parseEntries(text: string): ParsedEntry[] {
  const entries: EntryDraft[] = [];
  let current: EntryDraft | null = null;
  for (const line of text.split('\n')) {
    const m = line.match(ENTRY_HEAD);
    if (m) {
      if (current) entries.push(current);
      current = { id: m[1], title: m[2], meta: {}, body: [] };
      continue;
    }
    if (!current) continue;
    if (line.trim() === SEPARATOR) {
      entries.push(current);
      current = null;
      continue;
    }
    const pairs = metadataOf(line);
    if (pairs.length && pairs.some(([label]) => !(label in current!.meta))) {
      for (const [label, value] of pairs) {
        if (!(label in current.meta)) current.meta[label] = value;
      }
      continue;
    }
    current.body.push(line);
  }
  if (current) entries.push(current);
  return entries.map((e) => ({ ...e, body: e.body.join('\n').trim() }));
}

/** Collapses the blank-line runs a splice leaves behind, and ends the file with one newline. */
export function tidySurface(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');
}
