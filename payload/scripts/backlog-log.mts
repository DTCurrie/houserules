#!/usr/bin/env node
// Backlog ledger helper (claude-kit).
//
// Usage:
//   add    <prefix> <backlog-file> <title> [content]   # content from arg or stdin
//   remove <id>     <backlog-file> <reason>
//   update <id>     <backlog-file> <new-title> [content]
//   show   <id>                                        # decoded history for one ID
//   list   [<backlog-file>]                            # parsed entries from one or all backlogs
//
// IDs: <PREFIX>-<6 hex>, derived from sha256(prefix|title|isoTimestamp).
// Log: .claude/backlog.log, one JSON record per line. Body content is gzip+base64
// to keep the log compact while remaining decodable with `show`.
//
// Stack-agnostic: pure node builtins, repo root via git. The only Claude-Code-specific
// bit is detectChatId(), which stamps the active session; it degrades to a warning
// (chat:null) in any other harness, or pass --chat=none / set CLAUDE_SESSION_ID.

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
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';

import { repoRoot } from './lib/kit-config.mjs';
import { ENTRY_HEAD, makeId } from './lib/backlog-id.mjs';

const REPO_ROOT = repoRoot();
const LOG_FILE = resolve(REPO_ROOT, '.claude/backlog.log');

const SEPARATOR = '---';

const nowIso = () => new Date().toISOString();
const todayDate = () => nowIso().slice(0, 10);
const encodeBody = (s?: string) =>
  gzipSync(Buffer.from(s ?? '', 'utf8')).toString('base64');
const decodeBody = (s: string) =>
  gunzipSync(Buffer.from(s, 'base64')).toString('utf8');

// --- Chat (Claude Code session) detection -----------------------------------
// Transcripts live at ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl, where
// encoded-cwd is the absolute repo path with `/` replaced by `-`. The active
// session is identified by reading the most recent record from each transcript
// and picking the file whose tail timestamp is freshest. mtime alone isn't
// reliable when multiple sessions share the same project at once.

function projectTranscriptDir() {
  const encoded = REPO_ROOT.replaceAll('/', '-');
  return resolve(homedir(), '.claude/projects', encoded);
}

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
    const chunkSize = Math.min(size, 16384);
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

function detectChatId(): string | null {
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  const dir = projectTranscriptDir();
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

// Pull `--chat <id>` (or `--chat=<id>`) out of argv. Returns the id or null.
function takeChatFlag(argv: string[]): string | null {
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

function appendEvent(record: Record<string, unknown>) {
  appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
}

function readBacklog(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function ensureBacklogHeader(file: string) {
  if (existsSync(file)) return;
  const name = relative(REPO_ROOT, dirname(file)) || 'repo root';
  writeFileSync(
    file,
    `# Backlog — ${name}\n\nDeferred work. Add entries via \`.claude/scripts/backlog-log.mjs\`; remove on resolution.\n\n`,
  );
}

function readContentArg(content: string | undefined): string {
  if (content !== undefined) return content;
  // Read stdin if not a TTY.
  if (process.stdin.isTTY) return '';
  return readFileSync(0, 'utf8').trimEnd();
}

function renderEntry(
  id: string,
  title: string,
  body: string,
  dateOverride: string | null,
  chat: string | null,
): string {
  const date = dateOverride ?? todayDate();
  const trimmed = body.trim();
  const chatLine = chat ? `\n**Chat:** ${chat}` : '';
  return `## [${id}] ${title}\n\n**Logged:** ${date}${chatLine}\n\n${trimmed}\n\n${SEPARATOR}\n\n`;
}

interface EntryRange {
  start: number;
  end: number;
  date: string | null;
  chat: string | null;
  lines: string[];
}

function findEntryRange(text: string, id: string): EntryRange | null {
  const lines = text.split('\n');
  let start = -1;
  let date: string | null = null;
  let chat: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ENTRY_HEAD);
    if (m && m[1] === id) {
      start = i;
      // Look for "**Logged:**" / "**Chat:**" metadata lines in the next few.
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const dm = lines[j].match(/^\*\*Logged:\*\*\s+(\d{4}-\d{2}-\d{2})/);
        if (dm) date = dm[1];
        const cm = lines[j].match(/^\*\*Chat:\*\*\s+(\S+)/);
        if (cm) chat = cm[1];
      }
      break;
    }
  }
  if (start === -1) return null;
  // End at the next entry heading OR the next standalone --- line.
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
  // Consume one trailing blank line if present.
  while (end < lines.length && lines[end].trim() === '') end++;
  return { start, end, date, chat, lines };
}

interface ParsedEntry {
  id: string;
  title: string;
  date: string | null;
  chat: string | null;
  body: string;
}

interface EntryDraft {
  id: string;
  title: string;
  date: string | null;
  chat: string | null;
  body: string[];
}

function parseEntries(text: string): ParsedEntry[] {
  const lines = text.split('\n');
  const entries: EntryDraft[] = [];
  let current: EntryDraft | null = null;
  for (const line of lines) {
    const m = line.match(ENTRY_HEAD);
    if (m) {
      if (current) entries.push(current);
      current = { id: m[1], title: m[2], date: null, chat: null, body: [] };
      continue;
    }
    if (!current) continue;
    if (line.trim() === SEPARATOR) {
      entries.push(current);
      current = null;
      continue;
    }
    const dm = line.match(/^\*\*Logged:\*\*\s+(\d{4}-\d{2}-\d{2})/);
    if (dm && !current.date) {
      current.date = dm[1];
      continue;
    }
    const cm = line.match(/^\*\*Chat:\*\*\s+(\S+)/);
    if (cm && !current.chat) {
      current.chat = cm[1];
      continue;
    }
    current.body.push(line);
  }
  if (current) entries.push(current);
  return entries.map((e) => ({ ...e, body: e.body.join('\n').trim() }));
}

function findBacklogFiles(root = REPO_ROOT): string[] {
  const skip = new Set([
    'node_modules',
    '.git',
    '.svelte-kit',
    'dist',
    'build',
    '.turbo',
  ]);
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = resolve(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name === 'BACKLOG.md') out.push(full);
    }
  };
  walk(root);
  return out;
}

function relPath(p: string): string {
  return relative(REPO_ROOT, resolve(p));
}

function usage() {
  console.error(
    [
      'Usage:',
      '  backlog-log.mjs add    <prefix> <backlog-file> <title> [content] [--chat <id>]',
      '  backlog-log.mjs remove <id>     <backlog-file> <reason>',
      '  backlog-log.mjs update <id>     <backlog-file> <new-title> [content]',
      '  backlog-log.mjs show   <id>',
      '  backlog-log.mjs list   [<backlog-file>]',
      '',
      'When [content] is omitted for add/update, the body is read from stdin.',
      'add auto-detects the active Claude Code session ID; pass --chat <id> or',
      'set CLAUDE_SESSION_ID=<id> to override, or --chat=none to suppress.',
    ].join('\n'),
  );
}

const argv = process.argv.slice(2);
const chatFlag = takeChatFlag(argv);
const [action, ...rest] = argv;

switch (action) {
  case 'add': {
    const [prefix, file, title, content] = rest;
    if (!prefix || !file || !title) {
      usage();
      process.exit(1);
    }
    if (!/^[A-Z][A-Z0-9]*$/.test(prefix)) {
      console.error(
        `Invalid prefix "${prefix}" — must be uppercase ASCII (e.g. SIM, DATA, RULES).`,
      );
      process.exit(1);
    }
    const body = readContentArg(content);
    if (!body) {
      console.error(
        'Empty body. Pass content as the 4th arg or pipe via stdin.',
      );
      process.exit(1);
    }
    const id = makeId(prefix, title, nowIso());
    const chat = chatFlag === 'none' ? null : (chatFlag ?? detectChatId());
    ensureBacklogHeader(file);
    const existing = readBacklog(file);
    const padded = existing.replace(/\s*$/, '') + '\n\n';
    writeFileSync(file, padded + renderEntry(id, title, body, null, chat));
    appendEvent({
      ts: nowIso(),
      id,
      action: 'add',
      file: relPath(file),
      title,
      chat: chat ?? null,
      content: encodeBody(body),
    });
    console.log(id);
    if (chat) console.log(`chat: ${chat}`);
    else if (chatFlag !== 'none')
      console.error(
        'warning: no active Claude session detected; entry written without chat ID.',
      );
    break;
  }

  case 'remove': {
    const [id, file, reason] = rest;
    if (!id || !file || !reason) {
      usage();
      process.exit(1);
    }
    const text = readBacklog(file);
    const range = findEntryRange(text, id);
    if (!range) {
      console.error(`Entry ${id} not found in ${file}.`);
      process.exit(1);
    }
    const { start, end, lines } = range;
    const removed = lines.slice(0, start).concat(lines.slice(end)).join('\n');
    writeFileSync(
      file,
      removed.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n'),
    );
    const removeChat =
      chatFlag === 'none' ? null : (chatFlag ?? detectChatId());
    appendEvent({
      ts: nowIso(),
      id,
      action: 'remove',
      file: relPath(file),
      reason,
      chat: removeChat ?? null,
    });
    break;
  }

  case 'update': {
    const [id, file, newTitle, content] = rest;
    if (!id || !file || !newTitle) {
      usage();
      process.exit(1);
    }
    const body = readContentArg(content);
    const text = readBacklog(file);
    const range = findEntryRange(text, id);
    if (!range) {
      console.error(`Entry ${id} not found in ${file}.`);
      process.exit(1);
    }
    const { start, end, date, chat, lines } = range;
    const replacement = renderEntry(id, newTitle, body, date, chat).split('\n');
    // renderEntry ends with two blank lines; splitting yields a trailing "" — drop it
    // so the join below doesn't introduce an extra blank.
    while (replacement.length && replacement[replacement.length - 1] === '')
      replacement.pop();
    const next = lines
      .slice(0, start)
      .concat(replacement, '', lines.slice(end))
      .join('\n');
    writeFileSync(file, next.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n'));
    const updateChat =
      chatFlag === 'none' ? null : (chatFlag ?? detectChatId());
    appendEvent({
      ts: nowIso(),
      id,
      action: 'update',
      file: relPath(file),
      title: newTitle,
      chat: updateChat ?? null,
      content: encodeBody(body),
    });
    break;
  }

  case 'show': {
    const [id] = rest;
    if (!id) {
      usage();
      process.exit(1);
    }
    if (!existsSync(LOG_FILE)) {
      console.error('No backlog log yet.');
      process.exit(0);
    }
    const lines = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    let found = 0;
    for (const line of lines) {
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (r.id !== id) continue;
      found++;
      const headline = `[${r.ts}] ${r.action}${r.title ? ` — ${r.title}` : ''}${r.file ? ` (${r.file})` : ''}`;
      console.log(headline);
      if (r.chat) console.log(`chat: ${r.chat}`);
      if (r.content) console.log(decodeBody(r.content));
      if (r.reason) console.log(`reason: ${r.reason}`);
      console.log('---');
    }
    if (!found) {
      console.error(`No log entries for ${id}.`);
      process.exit(1);
    }
    break;
  }

  case 'list': {
    const [file] = rest;
    const files = file ? [resolve(file)] : findBacklogFiles();
    for (const f of files) {
      if (!existsSync(f) || !statSync(f).isFile()) continue;
      const entries = parseEntries(readFileSync(f, 'utf8'));
      if (!entries.length) continue;
      console.log(`# ${relPath(f)}`);
      for (const e of entries) {
        const date = e.date ?? '????-??-??';
        console.log(`  ${e.id}  ${date}  ${e.title}`);
      }
      console.log('');
    }
    break;
  }

  default:
    usage();
    process.exit(action ? 1 : 0);
}
