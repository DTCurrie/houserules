#!/usr/bin/env node
/**
 * Backlog ledger helper.
 *
 * Usage:
 *   add    <prefix> <area> <title> [content] [--issue <n>]  # content from arg or stdin
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
 * Chat provenance stamps the active session and is the one Claude-Code-specific part. It
 * degrades to a chat:null warning in any other harness. Pass --chat=none or set
 * CLAUDE_SESSION_ID to silence that.
 *
 * --issue <n> on add records the GitHub issue an entry was adopted from. A push then attaches
 * the existing issue to the board instead of creating a duplicate.
 */

import {
  existsSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfigSafe, repoRootSafe } from '@houserules/payload/config';
import { makeId } from '@houserules/payload/backlog-id';
import {
  SEPARATOR,
  appendEvent,
  areaNamesOf,
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
  surfaceIsResidue,
  surfaceRelFile,
  surfaceScope,
  takeChatFlag,
  unknownAreaMessage,
} from '@houserules/payload/entry-ledger';
import { findEntry, loadIndex } from '@houserules/payload/ledger-index';
import type {
  LedgerEntry,
  LedgerIndex,
} from '@houserules/payload/ledger-index';

function requireRepoRoot(): string {
  const root = repoRootSafe();
  if (root === null) {
    console.error(
      'backlog-log.mjs requires a git work tree. Run it from inside a git repository.',
    );
    process.exit(0);
  }
  return root;
}

const REPO_ROOT = requireRepoRoot();
const CONFIG = loadConfigSafe();
const LEDGER_DIR = ledgerDir(REPO_ROOT, CONFIG.ledgers?.dir);
const LOG_FILE = ledgerPath(REPO_ROOT, 'backlog', CONFIG.ledgers?.dir);
const SURFACE = 'BACKLOG.md';
const BACKLOG_INDEX = loadIndex(LEDGER_DIR, 'backlog');

/** The local enable token a projects sync bootstrap writes into the ledger directory. */
const PROJECTS_ENABLE_TOKEN = '.projects.json';

/**
 * Whether the pulled index, rather than the queue, is the store this surface renders from.
 *
 * Without a projects sync the queue is the only durable copy of an entry, so a surface holding
 * entries the queue cannot account for means the queue was truncated and rewriting would drop
 * them. With a sync configured the model inverts: `backlog.jsonl` is a push queue drained to
 * zero after a successful push, and the board is the durable store, pulled into
 * `backlog.index.json`. A fully synced repo therefore sits at zero queued records with a
 * rendered surface, which the queue comparison reads as corruption and refuses forever.
 *
 * The index has to be on disk for this. A repo that enabled the sync but has never pulled knows
 * nothing about the board, so the queue comparison is still the only safe one there.
 */
function indexIsAuthoritative(): boolean {
  if (!existsSync(resolve(LEDGER_DIR, PROJECTS_ENABLE_TOKEN))) return false;
  return BACKLOG_INDEX !== null;
}

function resolveSurfaceArg(file?: string): string {
  return resolveSurfaceArgSeam(
    REPO_ROOT,
    LEDGER_DIR,
    SURFACE,
    CONFIG.targets ?? [],
    file,
  );
}

/**
 * Exits with the shared unknown-area message when `file` names an area no target configures.
 * Every command that resolves a surface from an `<area>` argument calls this first.
 */
function requireKnownArea(file: string | undefined): void {
  const message = unknownAreaMessage(
    file,
    SURFACE,
    CONFIG.targets ?? [],
    areaNamesOf(allSurfaceFiles(), LEDGER_DIR, SURFACE, CONFIG.targets ?? []),
  );
  if (message === null) return;
  console.error(message);
  process.exit(1);
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
  issue?: number;
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

/**
 * `entry` as a {@link BacklogEntry}.
 *
 * The board holds a decoded body, but every other reader of `BacklogEntry.content` in this file
 * expects the gzip+base64 shape a queue record carries, so this re-encodes it rather than
 * changing what `decodeBody` is fed downstream.
 */
function backlogEntryFromLedgerEntry(entry: LedgerEntry): BacklogEntry {
  return {
    id: entry.id,
    file: entry.surface,
    title: entry.title,
    date: entry.date,
    chat: entry.chat,
    content: encodeBody(entry.body),
  };
}

/** The board `Status` a finished backlog item carries. */
const CLOSED_BOARD_STATUS = 'Done';

/**
 * The latest title and content per id, plus which ids a later record removed.
 *
 * Starts from `index`'s entries, the board's own state, then replays the queue's records over
 * them in append order. A queue record always wins over the index for the same id, because the
 * queue is what has not reached the board yet.
 */
function projectBacklog(
  records: BacklogRecord[],
  index: LedgerIndex | null,
): {
  entries: Map<string, BacklogEntry>;
  removed: Set<string>;
} {
  const entries = new Map<string, BacklogEntry>();
  const removed = new Set<string>();
  for (const entry of index?.entries ?? []) {
    entries.set(entry.id, backlogEntryFromLedgerEntry(entry));
    // A Done item is finished work the board still holds. It stays in `entries`, so `show` and
    // prompt injection can still resolve the id, and it goes straight into `removed`, so no list
    // or render ever shows it. Without this, dropping a resolved entry locally and pulling it
    // back reopens it, and after the queue empties that happens to every entry ever closed.
    if (entry.status === CLOSED_BOARD_STATUS) removed.add(entry.id);
  }
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
      'silently drop entries the ledger has not recorded as removed. The ledger is not ' +
      'tracked by git, so do not overwrite it blind. If a projects sync is configured, ' +
      'run `projects-sync.mjs push` first to land any unsynced entries on the board, ' +
      'then copy a good ledger from another checkout or machine before retrying.',
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
  if (
    !indexIsAuthoritative() &&
    rebuildWouldDropEntries(file, nextContent, intentionallyDropped)
  )
    failRebuild(relFile);
  // After the drop guard, never before it. An undeclared area losing its last entry is residue,
  // but a file on disk carrying entries the ledger cannot account for is still a refusal.
  if (surfaceIsResidue(file, SURFACE, entries.length, CONFIG.targets ?? [])) {
    rmSync(file, { force: true });
    return;
  }
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
  const { entries, removed } = projectBacklog(
    readLog<BacklogRecord>(LOG_FILE),
    BACKLOG_INDEX,
  );
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
  const { entries, removed } = projectBacklog(
    readLog<BacklogRecord>(LOG_FILE),
    BACKLOG_INDEX,
  );
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

function parseIssueFlag(value: string | undefined): number {
  const n = Number(value);
  if (!value || !Number.isInteger(n) || n <= 0) {
    console.error(
      `Invalid --issue "${value ?? ''}". Must be a positive integer.`,
    );
    process.exit(1);
  }
  return n;
}

/** Splices `--issue <n>` or `--issue=<n>` out of argv, wherever it appears, and returns the value. */
function takeIssueFlag(argv: string[]): number | null {
  const eq = '--issue=';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--issue') {
      const v = argv[i + 1];
      argv.splice(i, 2);
      return parseIssueFlag(v);
    }
    if (a?.startsWith(eq)) {
      argv.splice(i, 1);
      return parseIssueFlag(a.slice(eq.length));
    }
  }
  return null;
}

function usage() {
  console.error(
    [
      'Usage:',
      '  backlog-log.mjs add    <prefix> <area> <title> [content] [--chat <id>] [--issue <n>]',
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
      'add --issue <n> records the GitHub issue this entry was adopted from, so a later',
      'push attaches that issue instead of creating a new one.',
    ].join('\n'),
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  const chatFlag = takeChatFlag(argv);
  const issueFlag = takeIssueFlag(argv);
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
      requireKnownArea(file);
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
        ...(issueFlag !== null ? { issue: issueFlag } : {}),
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
      requireKnownArea(file);
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
      requireKnownArea(file);
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
      requireKnownArea(toArea);
      const destination = resolveSurfaceArg(toArea);
      const { entries, removed } = projectBacklog(
        readLog<BacklogRecord>(LOG_FILE),
        BACKLOG_INDEX,
      );
      const entry = entries.get(id);
      if (!entry || removed.has(id))
        entryNotFound(id, relativeToRoot(REPO_ROOT, LOG_FILE));
      const sourceArea = normalizeSurfaceRef(
        entry.file,
        SURFACE,
        CONFIG.targets ?? [],
      );
      requireKnownArea(sourceArea);
      const source = resolveSurfaceArg(sourceArea);
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
      // Not gated on the log existing. Once an entry syncs it leaves the queue, so the queue
      // being absent entirely is an ordinary state and the index is where the answer lives.
      let found = 0;
      for (const r of existsSync(LOG_FILE)
        ? readLog<BacklogRecord>(LOG_FILE)
        : []) {
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
        // The queue no longer holds it, which is the ordinary state for anything already synced.
        // The index still does, so a closed id a decision cites stays resolvable.
        const cached = findEntry(BACKLOG_INDEX, id);
        if (!cached && !existsSync(LOG_FILE)) {
          console.error('No backlog log yet.');
          process.exit(0);
        }
        if (!cached) {
          console.error(`No log entries for ${id}.`);
          process.exit(1);
        }
        console.log(
          `[${cached.date}] on the board — ${cached.title} (${cached.surface})`,
        );
        if (cached.status) console.log(`status: ${cached.status}`);
        if (cached.chat) console.log(`chat: ${cached.chat}`);
        console.log(cached.body);
        console.log('---');
      }
      break;
    }

    case 'list': {
      const [file] = rest;
      requireKnownArea(file);
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
      requireKnownArea(file);
      const files = file ? [resolveSurfaceArg(file)] : allSurfaceFiles();
      for (const f of files) rerenderFile(f);
      break;
    }

    default:
      usage();
      process.exit(action ? 1 : 0);
  }
}

// Both sides go through `realpathSync` before comparing. `process.argv[1]` stays the literal
// invocation path, but `import.meta.url` for the entry module resolves through any symlink in
// its ancestry (macOS's /tmp -> /private/tmp among them), so comparing the raw strings missed
// on any repo staged under a symlinked temp dir and this script never ran as the CLI.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
