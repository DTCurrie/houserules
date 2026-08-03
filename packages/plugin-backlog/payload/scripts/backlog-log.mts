#!/usr/bin/env node
/**
 * Backlog ledger helper.
 *
 * Usage:
 *   add    <prefix> <backlog-file> <title> [content]   # content from arg or stdin
 *   remove <id>     <backlog-file> <reason>
 *   update <id>     <backlog-file> <new-title> [content]
 *   show   <id>                                        # decoded history for one ID
 *   list   [<backlog-file>]                            # parsed entries from one or all backlogs
 *
 * Log: .claude/backlog.log, one JSON record per line. Body content is gzip+base64 to keep
 * the log compact while remaining decodable with `show`.
 *
 * The ledger mechanics live in lib/entry-ledger.mjs, shared with the other ledgers. This
 * script owns only what is specific to a backlog: the entry shape, the header, and the verbs.
 *
 * Chat provenance stamps the active session and is the one Claude-Code-specific part. It
 * degrades to a chat:null warning in any other harness. Pass --chat=none or set
 * CLAUDE_SESSION_ID to silence that.
 */

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { repoRoot } from './lib/kit-config.mjs';
import { makeId } from './lib/backlog-id.mjs';
import {
  SEPARATOR,
  appendEvent,
  decodeBody,
  encodeBody,
  ensureSurfaceHeader,
  findEntryRange,
  findSurfaceFiles,
  nowIso,
  parseEntries,
  readContentArg,
  readLog,
  readSurface,
  relativeToRoot,
  renderMetadata,
  resolveChat,
  takeChatFlag,
  tidySurface,
  todayDate,
} from './lib/entry-ledger.mjs';

const REPO_ROOT = repoRoot();
const LOG_FILE = resolve(REPO_ROOT, '.claude/backlog.log');
const SURFACE = 'BACKLOG.md';

interface BacklogRecord {
  ts: string;
  id: string;
  action: string;
  file?: string;
  title?: string;
  reason?: string;
  chat?: string | null;
  content?: string;
}

function backlogHeader(file: string): string {
  const name = relative(REPO_ROOT, dirname(resolve(file))) || 'repo root';
  return `# Backlog — ${name}\n\nDeferred work. Add entries via \`.claude/scripts/backlog-log.mjs\`; remove on resolution.\n\n`;
}

function renderEntry(
  id: string,
  title: string,
  body: string,
  date: string | null,
  chat: string | null,
): string {
  const meta = renderMetadata({ Logged: date ?? todayDate(), Chat: chat });
  return `## [${id}] ${title}\n\n${meta}\n\n${body.trim()}\n\n${SEPARATOR}\n\n`;
}

function spliceEntry(
  file: string,
  id: string,
  replacement: string[] | null,
): boolean {
  const range = findEntryRange(readSurface(file), id);
  if (!range) return false;
  const { start, end, lines } = range;
  const head = lines.slice(0, start);
  const tail = lines.slice(end);
  const next = replacement
    ? head.concat(replacement, '', tail)
    : head.concat(tail);
  writeFileSync(file, tidySurface(next.join('\n')));
  return true;
}

function entryNotFound(id: string, file: string): never {
  console.error(`Entry ${id} not found in ${file}.`);
  process.exit(1);
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
    const chat = resolveChat(chatFlag, REPO_ROOT);
    ensureSurfaceHeader(file, backlogHeader(file));
    const padded = readSurface(file).replace(/\s*$/, '') + '\n\n';
    writeFileSync(file, padded + renderEntry(id, title, body, null, chat));
    appendEvent(LOG_FILE, {
      ts: nowIso(),
      id,
      action: 'add',
      file: relativeToRoot(REPO_ROOT, file),
      title,
      chat,
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
    if (!spliceEntry(file, id, null)) entryNotFound(id, file);
    appendEvent(LOG_FILE, {
      ts: nowIso(),
      id,
      action: 'remove',
      file: relativeToRoot(REPO_ROOT, file),
      reason,
      chat: resolveChat(chatFlag, REPO_ROOT),
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
    const range = findEntryRange(readSurface(file), id);
    if (!range) entryNotFound(id, file);
    // renderEntry ends with two blank lines; splitting yields a trailing "" — drop it so
    // the splice does not introduce an extra blank.
    const replacement = renderEntry(
      id,
      newTitle,
      body,
      range.meta.Logged ?? null,
      range.meta.Chat ?? null,
    ).split('\n');
    while (replacement.length && replacement[replacement.length - 1] === '')
      replacement.pop();
    spliceEntry(file, id, replacement);
    appendEvent(LOG_FILE, {
      ts: nowIso(),
      id,
      action: 'update',
      file: relativeToRoot(REPO_ROOT, file),
      title: newTitle,
      chat: resolveChat(chatFlag, REPO_ROOT),
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
    let found = 0;
    for (const r of readLog<BacklogRecord>(LOG_FILE)) {
      if (r.id !== id) continue;
      found++;
      console.log(
        `[${r.ts}] ${r.action}${r.title ? ` — ${r.title}` : ''}${r.file ? ` (${r.file})` : ''}`,
      );
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
    const files = file ? [resolve(file)] : findSurfaceFiles(REPO_ROOT, SURFACE);
    for (const f of files) {
      if (!existsSync(f) || !statSync(f).isFile()) continue;
      const entries = parseEntries(readSurface(f));
      if (!entries.length) continue;
      console.log(`# ${relativeToRoot(REPO_ROOT, f)}`);
      for (const e of entries) {
        console.log(`  ${e.id}  ${e.meta.Logged ?? '????-??-??'}  ${e.title}`);
      }
      console.log('');
    }
    break;
  }

  default:
    usage();
    process.exit(action ? 1 : 0);
}
