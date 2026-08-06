#!/usr/bin/env node
/**
 * Backlog ledger helper.
 *
 * Usage:
 *   add    <prefix> <area> <title> [content]  # content from arg or stdin
 *   remove <id>     <area> <reason>
 *   update <id>     <area> <new-title> [content]
 *   move   <id>     <to-area>                 # re-file an entry onto another surface
 *   show   <id>                               # decoded history for one ID
 *   list   [<area>]                           # parsed entries from one or all backlogs
 *   render [<area>]                           # rebuild a surface from the ledger alone
 *
 * Log: .claude/ledgers/backlog.jsonl, one JSON record per line. Body content is gzip+base64 to
 * keep the log compact while remaining decodable with `show`. The default rendered surface
 * lives beside it, at .claude/ledgers/BACKLOG.md, and a monorepo area renders alongside it as
 * .claude/ledgers/<target>.BACKLOG.md.
 *
 * Every `<area>` above is a bare target name, and omitting it means the repo-root surface. A
 * path ending in BACKLOG.md names the same area and resolves to the same file, so
 * `games/tower-push/BACKLOG.md` and `tower-push` both write
 * .claude/ledgers/tower-push.BACKLOG.md.
 *
 * The ledger is the source of truth. add/remove/update append a record and then rewrite the
 * surface file from the ledger alone, rather than editing the file's text directly, so a repo
 * that gitignores its rendered surfaces can still reconstruct them with `render`. An entry never
 * logged through this script does not exist as far as a rewrite is concerned.
 *
 * The ledger mechanics live in lib/entry-ledger.mjs, shared with the other ledgers. This
 * script owns only what is specific to a backlog: the entry shape, the header, and the verbs.
 *
 * Chat provenance stamps the active session and is the one Claude-Code-specific part. It
 * degrades to a chat:null warning in any other harness. Pass --chat=none or set
 * CLAUDE_SESSION_ID to silence that.
 */

import { existsSync, statSync, writeFileSync } from 'node:fs';

import { loadConfigSafe, repoRoot } from './lib/kit-config.mjs';
import { makeId } from './lib/backlog-id.mjs';
import {
  SEPARATOR,
  appendEvent,
  decodeBody,
  encodeBody,
  impliedSurfaceFiles,
  ledgerDir,
  ledgerPath,
  normalizeSurfaceRef,
  nowIso,
  parseEntries,
  readContentArg,
  readLog,
  readSurface,
  rebuildWouldDropEntries,
  relativeToRoot,
  renderMetadata,
  resolveChat,
  resolveSurfaceArg as resolveSurfaceArgSeam,
  surfaceRelFile,
  surfaceScope,
  takeChatFlag,
} from './lib/entry-ledger.mjs';

const REPO_ROOT = repoRoot();
const CONFIG = loadConfigSafe();
const LEDGER_DIR = ledgerDir(REPO_ROOT, CONFIG.ledgers?.dir);
const LOG_FILE = ledgerPath(REPO_ROOT, 'backlog', CONFIG.ledgers?.dir);
const SURFACE = 'BACKLOG.md';

function resolveSurfaceArg(file?: string): string {
  return resolveSurfaceArgSeam(
    REPO_ROOT,
    LEDGER_DIR,
    SURFACE,
    CONFIG.targets ?? [],
    file,
  );
}

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

interface BacklogEntry {
  id: string;
  file: string;
  title: string;
  date: string;
  chat: string | null;
  content: string;
}

function backlogHeader(file: string): string {
  const name = surfaceScope(file, SURFACE, CONFIG.targets ?? []);
  return `# Backlog — ${name}\n\nDeferred work. Add entries via \`.claude/scripts/backlog-log.mjs\`; remove on resolution.\n\n`;
}

function renderEntry(
  id: string,
  title: string,
  body: string,
  date: string,
  chat: string | null,
): string {
  const meta = renderMetadata({ Logged: date, Chat: chat });
  return `## [${id}] ${title}\n\n${meta}\n\n${body.trim()}\n\n${SEPARATOR}\n\n`;
}

/** The latest title and content per id, plus which ids a later record removed. */
function projectBacklog(records: BacklogRecord[]): {
  entries: Map<string, BacklogEntry>;
  removed: Set<string>;
} {
  const entries = new Map<string, BacklogEntry>();
  const removed = new Set<string>();
  for (const r of records) {
    if (r.action === 'add') {
      entries.set(r.id, {
        id: r.id,
        file: r.file ?? '',
        title: r.title ?? '',
        date: r.ts.slice(0, 10),
        chat: r.chat ?? null,
        content: r.content ?? '',
      });
      removed.delete(r.id);
    } else if (r.action === 'update') {
      const e = entries.get(r.id);
      if (!e) continue;
      if (r.title !== undefined) e.title = r.title;
      if (r.content !== undefined) e.content = r.content;
    } else if (r.action === 'move') {
      const e = entries.get(r.id);
      if (!e) continue;
      if (r.file !== undefined) e.file = r.file;
    } else if (r.action === 'remove') {
      removed.add(r.id);
    }
  }
  return { entries, removed };
}

function renderSurface(file: string, entries: BacklogEntry[]): string {
  const body = entries
    .map((e) =>
      renderEntry(e.id, e.title, decodeBody(e.content), e.date, e.chat),
    )
    .join('');
  return backlogHeader(file) + body;
}

function failRebuild(relFile: string): never {
  console.error(
    `Refusing to rewrite ${relFile}: the backlog ledger at ${LOG_FILE} does not ` +
      `account for every entry ${relFile} already carries. Rewriting now would ` +
      'silently drop entries the ledger has not recorded as removed. Restore the ' +
      'ledger with `git checkout -- .claude/ledgers/backlog.jsonl`, or copy it from ' +
      'another checkout, then retry.',
  );
  process.exit(1);
}

function writeSurface(
  file: string,
  entries: BacklogEntry[],
  intentionallyDropped: ReadonlySet<string> = new Set(),
): void {
  const relFile = relativeToRoot(REPO_ROOT, file);
  const nextContent = renderSurface(file, entries);
  if (rebuildWouldDropEntries(file, nextContent, intentionallyDropped))
    failRebuild(relFile);
  writeFileSync(file, nextContent);
}

/**
 * The surviving entries for `file`, projected from the ledger alone, in ledger append order,
 * plus every id the ledger records as removed.
 */
function projectFile(file: string): {
  surviving: BacklogEntry[];
  removed: Set<string>;
} {
  const relFile = normalizeSurfaceRef(
    surfaceRelFile(LEDGER_DIR, file),
    SURFACE,
    CONFIG.targets ?? [],
  );
  const { entries, removed } = projectBacklog(readLog<BacklogRecord>(LOG_FILE));
  const surviving = [...entries.values()].filter(
    (e) =>
      normalizeSurfaceRef(e.file, SURFACE, CONFIG.targets ?? []) === relFile &&
      !removed.has(e.id),
  );
  return { surviving, removed };
}

/**
 * Rebuilds one surface file from the log alone, in ledger append order.
 *
 * `extraDropped` names ids the caller is intentionally excising from this surface for a
 * reason the ledger's `removed` set does not capture, such as a `move` off it, so the
 * rewrite guard does not mistake the loss for an unrecorded one.
 */
function rerenderFile(
  file: string,
  extraDropped: ReadonlySet<string> = new Set(),
): void {
  const { surviving, removed } = projectFile(file);
  writeSurface(file, surviving, new Set([...removed, ...extraDropped]));
}

/**
 * Every surface the ledger currently projects onto, plus every one on disk.
 *
 * Read off the SURVIVING entries rather than off every recorded `file`. A record's `file` is
 * where the entry lived when that record was written, so an entry moved to another surface
 * leaves its origin in the log forever. Deriving from history rebuilds that origin as a
 * header-only stub on every render, which reads as an area that still exists and holds nothing.
 */
function allSurfaceFiles(): string[] {
  const { entries, removed } = projectBacklog(readLog<BacklogRecord>(LOG_FILE));
  const surviving = [...entries.values()].filter((e) => !removed.has(e.id));
  return impliedSurfaceFiles(
    LEDGER_DIR,
    SURFACE,
    surviving.map((e) => e.file),
    CONFIG.targets ?? [],
  );
}

/**
 * The entries `list` prints for one surface. Reads the rendered markdown when it exists on
 * disk, and projects straight from the ledger when it does not, so a surface the ledger implies
 * but nothing has rendered yet still reports its live entries.
 */
function listEntries(
  file: string,
): { id: string; title: string; logged: string }[] {
  if (existsSync(file) && statSync(file).isFile()) {
    return parseEntries(readSurface(file)).map((e) => ({
      id: e.id,
      title: e.title,
      logged: e.meta.Logged ?? '????-??-??',
    }));
  }
  return projectFile(file).surviving.map((e) => ({
    id: e.id,
    title: e.title,
    logged: e.date,
  }));
}

function entryNotFound(id: string, file: string): never {
  console.error(
    `The backlog ledger has no record of ${id}. The ledger is the source of truth, so an entry only present in ${file} does not exist.`,
  );
  process.exit(1);
}

function usage() {
  console.error(
    [
      'Usage:',
      '  backlog-log.mjs add    <prefix> <area> <title> [content] [--chat <id>]',
      '  backlog-log.mjs remove <id>     <area> <reason>',
      '  backlog-log.mjs update <id>     <area> <new-title> [content]',
      '  backlog-log.mjs move   <id>     <to-area>',
      '  backlog-log.mjs show   <id>',
      '  backlog-log.mjs list   [<area>]',
      '  backlog-log.mjs render [<area>]',
      '',
      'When [content] is omitted for add/update, the body is read from stdin.',
      '<area> is required and is a bare target name (e.g. studio), resolving to that',
      "area's surface inside the ledger directory. Pass BACKLOG.md for the repo-root",
      'backlog. A path ending in BACKLOG.md names the same area and resolves to the',
      'same file.',
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
    const surface = resolveSurfaceArg(file);
    const id = makeId(prefix, title, nowIso());
    const chat = resolveChat(chatFlag, REPO_ROOT);
    appendEvent(LOG_FILE, {
      ts: nowIso(),
      id,
      action: 'add',
      file: surfaceRelFile(LEDGER_DIR, surface),
      title,
      chat,
      content: encodeBody(body),
    });
    rerenderFile(surface);
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
    const surface = resolveSurfaceArg(file);
    const { surviving } = projectFile(surface);
    if (!surviving.some((e) => e.id === id))
      entryNotFound(id, relativeToRoot(REPO_ROOT, surface));
    appendEvent(LOG_FILE, {
      ts: nowIso(),
      id,
      action: 'remove',
      file: surfaceRelFile(LEDGER_DIR, surface),
      reason,
      chat: resolveChat(chatFlag, REPO_ROOT),
    });
    rerenderFile(surface);
    break;
  }

  case 'update': {
    const [id, file, newTitle, content] = rest;
    if (!id || !file || !newTitle) {
      usage();
      process.exit(1);
    }
    const body = readContentArg(content);
    const surface = resolveSurfaceArg(file);
    const { surviving } = projectFile(surface);
    if (!surviving.some((e) => e.id === id))
      entryNotFound(id, relativeToRoot(REPO_ROOT, surface));
    appendEvent(LOG_FILE, {
      ts: nowIso(),
      id,
      action: 'update',
      file: surfaceRelFile(LEDGER_DIR, surface),
      title: newTitle,
      chat: resolveChat(chatFlag, REPO_ROOT),
      content: encodeBody(body),
    });
    rerenderFile(surface);
    break;
  }

  case 'move': {
    const [id, toArea] = rest;
    if (!id || !toArea) {
      usage();
      process.exit(1);
    }
    const destination = resolveSurfaceArg(toArea);
    const { entries, removed } = projectBacklog(
      readLog<BacklogRecord>(LOG_FILE),
    );
    const entry = entries.get(id);
    if (!entry || removed.has(id))
      entryNotFound(id, relativeToRoot(REPO_ROOT, LOG_FILE));
    const source = resolveSurfaceArg(
      normalizeSurfaceRef(entry.file, SURFACE, CONFIG.targets ?? []),
    );
    appendEvent(LOG_FILE, {
      ts: nowIso(),
      id,
      action: 'move',
      file: surfaceRelFile(LEDGER_DIR, destination),
      chat: resolveChat(chatFlag, REPO_ROOT),
    });
    rerenderFile(source, new Set([id]));
    rerenderFile(destination);
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
    const files = file ? [resolveSurfaceArg(file)] : allSurfaceFiles();
    for (const f of files) {
      const entries = listEntries(f);
      if (!entries.length) continue;
      console.log(`# ${relativeToRoot(REPO_ROOT, f)}`);
      for (const e of entries) {
        console.log(`  ${e.id}  ${e.logged}  ${e.title}`);
      }
      console.log('');
    }
    break;
  }

  case 'render': {
    const [file] = rest;
    const files = file ? [resolveSurfaceArg(file)] : allSurfaceFiles();
    for (const f of files) rerenderFile(f);
    break;
  }

  default:
    usage();
    process.exit(action ? 1 : 0);
}
