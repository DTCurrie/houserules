#!/usr/bin/env node
/**
 * Decision ledger helper.
 *
 * Usage:
 *   decide    <prefix> <area> <title> [body] [--under <id>] [--supersedes <id>,<id>]
 *             [--scope <path>,<path>] [--chat <id>]
 *   supersede <id> <area> <new-title> [body] [--scope <path>,<path>] [--chat <id>]
 *   amend     <id> <area> <new-body>
 *   move      <id> <to-area>
 *   show      <id>
 *   list      [<area>]
 *   render    [<area>]
 *   ancestry  <id>
 *   current   <id>
 *   tree      <id>
 *   scope     <path> [<path>...]
 *
 * Log: .claude/ledgers/decisions.jsonl (or `ledgers.dir` from kit.config.json), one JSON
 * record per line. Body content is gzip+base64. Status is never stored. A record is
 * superseded once its id appears in a later record's `supersedes` array, and `list`/
 * `render` derive that in one pass over the log.
 *
 * Every `<area>` above resolves against the ledger directory. Omitted, or the surface basename
 * itself, means the repo-root surface at `<dir>/DECISIONS.md`. A bare word names an area, at
 * `<dir>/<word>.DECISIONS.md`. A path ending in DECISIONS.md names the same area and resolves
 * to the same file. Any other path is honored literally.
 *
 * ancestry/current/tree/scope walk the same in-memory projection and print one line per
 * node: id, title, status. ancestry and tree are indented by depth, since supersedes and
 * under can each branch. No traversal prints a body; `show` is the only command that does,
 * and only for one id.
 *
 * The ledger mechanics live in lib/entry-ledger.mjs, shared with backlog-log.mjs. This
 * script owns what is specific to a decision: the record shape, the edges, and the verbs.
 *
 * Chat provenance stamps the active session and degrades to a chat:null warning outside
 * Claude Code. Pass --chat=none or set CLAUDE_SESSION_ID to override.
 */

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

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
  resolveSurfaceArg,
  surfaceScope,
  takeChatFlag,
  todayDate,
} from './lib/entry-ledger.mjs';

const REPO_ROOT = repoRoot();
const CONFIG = loadConfigSafe();
const LEDGER_DIR = ledgerDir(REPO_ROOT, CONFIG.ledgers?.dir);
const LOG_FILE = ledgerPath(REPO_ROOT, 'decisions', CONFIG.ledgers?.dir);
const SURFACE = 'DECISIONS.md';

function resolveSurfaceFile(fileArg?: string): string {
  return resolveSurfaceArg(
    REPO_ROOT,
    LEDGER_DIR,
    SURFACE,
    CONFIG.targets ?? [],
    fileArg,
  );
}

/** The surface-relative path recorded on each entry: the file's location inside the ledger directory. */
function surfaceRelFile(file: string): string {
  return relative(LEDGER_DIR, resolve(file));
}

interface DecisionRecord {
  ts: string;
  id: string;
  action: 'decide' | 'supersede' | 'amend' | 'move';
  file?: string;
  title?: string;
  supersedes?: string[];
  under?: string;
  scope?: string[];
  chat?: string | null;
  content?: string;
}

interface DecisionEntry {
  id: string;
  file: string;
  title: string;
  date: string;
  supersedes: string[];
  under: string | null;
  scope: string[];
  chat: string | null;
  content: string;
}

interface Projection {
  entries: Map<string, DecisionEntry>;
  superseded: Set<string>;
}

/** One pass over the log: the latest content per id, and which ids a later record superseded. */
function projectDecisions(records: DecisionRecord[]): Projection {
  const entries = new Map<string, DecisionEntry>();
  const superseded = new Set<string>();
  for (const r of records) {
    if (r.action === 'decide' || r.action === 'supersede') {
      entries.set(r.id, {
        id: r.id,
        file: r.file ?? '',
        title: r.title ?? '',
        date: r.ts.slice(0, 10),
        supersedes: r.supersedes ?? [],
        under: r.under ?? null,
        scope: r.scope ?? [],
        chat: r.chat ?? null,
        content: r.content ?? '',
      });
      for (const target of r.supersedes ?? []) superseded.add(target);
    } else if (r.action === 'amend') {
      const existing = entries.get(r.id);
      if (existing && r.content !== undefined) existing.content = r.content;
    } else if (r.action === 'move') {
      const existing = entries.get(r.id);
      if (existing && r.file !== undefined) existing.file = r.file;
    }
  }
  return { entries, superseded };
}

/** The id that superseded each target, derived from every entry's `supersedes` list. */
function supersededByOf(
  entries: Map<string, DecisionEntry>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries.values()) {
    for (const target of e.supersedes) map.set(target, e.id);
  }
  return map;
}

/** Direct children under each parent id, derived from every entry's `under` field. */
function underChildrenOf(
  entries: Map<string, DecisionEntry>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of entries.values()) {
    if (!e.under) continue;
    const list = map.get(e.under) ?? [];
    list.push(e.id);
    map.set(e.under, list);
  }
  return map;
}

/** One line per node, indented by depth: id, title, status. Never a body. */
function printEntryLine(
  e: DecisionEntry,
  superseded: Set<string>,
  depth: number,
): void {
  const status = superseded.has(e.id) ? 'superseded' : 'accepted';
  console.log(`${'  '.repeat(depth)}${e.id}  ${e.title}  ${status}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function requireKnownId(
  entries: Map<string, DecisionEntry>,
  id: string,
  context: string,
): void {
  if (!entries.has(id))
    fail(`${context} ${id} does not resolve in the decision log.`);
}

function requireAccepted(
  superseded: Set<string>,
  id: string,
  context: string,
): void {
  if (superseded.has(id)) fail(`${context} ${id} is already superseded.`);
}

/** Walks the under-chain from `under` to make sure adding `newId -> under` cannot loop back. */
function requireNoUnderCycle(
  entries: Map<string, DecisionEntry>,
  newId: string,
  under: string,
): void {
  let current: string | null = under;
  const seen = new Set<string>();
  while (current) {
    if (current === newId) {
      fail(`--under ${under} would create a cycle back to this record.`);
    }
    if (seen.has(current)) return;
    seen.add(current);
    current = entries.get(current)?.under ?? null;
  }
}

const normalizeScopePath = (p: string): string =>
  p.replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * Whether a recorded scope and a queried path govern each other, in either direction.
 *
 * Exact equality alone makes `scope` unusable for the question it exists to answer. A
 * decision scoped to `packages/cli/src/modules` governs every file beneath it, so querying
 * `packages/cli/src/modules/core.ts` has to find it. An exact-only match returns nothing
 * there, which reads as "no decision applies" and is a confident false negative.
 *
 * The reverse direction matters too: asking about a directory should surface a decision
 * scoped to one file inside it, since that decision still constrains work in that area.
 */
function scopesOverlap(recorded: string, queried: string): boolean {
  if (recorded === queried) return true;
  return (
    queried.startsWith(`${recorded}/`) || recorded.startsWith(`${queried}/`)
  );
}

function splitList(flag: string | null): string[] {
  return flag
    ? flag
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

function takeFlag(argv: string[], name: string): string | null {
  const eq = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) {
      const v = argv[i + 1];
      argv.splice(i, 2);
      return v ?? null;
    }
    if (a?.startsWith(eq)) {
      argv.splice(i, 1);
      return a.slice(eq.length) || null;
    }
  }
  return null;
}

function validatePrefix(prefix: string): void {
  if (!/^[A-Z][A-Z0-9]*$/.test(prefix)) {
    fail(
      `Invalid prefix "${prefix}". Must be uppercase ASCII, such as SIM, DATA, or RULES.`,
    );
  }
}

function decisionHeader(file: string): string {
  const name = surfaceScope(file, SURFACE, CONFIG.targets);
  return `# Decisions — ${name}\n\nAppend-only decision log. Add entries via \`.claude/scripts/decision-log.mjs\`.\n\n`;
}

/** One `**Label:** value` row, its fields joined by \` · \` and absent fields dropped. */
function metaRow(fields: Record<string, string | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => renderMetadata({ [k]: v }))
    .filter(Boolean)
    .join(' · ');
}

function renderEntry(
  e: DecisionEntry,
  status: 'accepted' | 'superseded',
  supersededById: string | null,
): string {
  const scope = e.scope.length
    ? e.scope.map((p) => `\`${p}\``).join(', ')
    : null;
  const meta = [
    metaRow({ Decided: e.date, Status: status }),
    metaRow({
      Supersedes: e.supersedes.length ? e.supersedes.join(', ') : null,
      Under: e.under,
    }),
    metaRow({
      'Superseded by': status === 'superseded' ? supersededById : null,
    }),
    metaRow({ Chat: e.chat }),
    metaRow({ Scope: scope }),
  ]
    .filter(Boolean)
    .join('\n');
  const body = e.content ? decodeBody(e.content).trim() : '';
  return `## [${e.id}] ${e.title}\n\n${meta}\n\n${body}\n\n${SEPARATOR}\n\n`;
}

/**
 * The entries recorded for `file`, projected from the ledger alone, plus which of them the
 * log records as superseded and by what.
 */
function projectFileEntries(file: string): {
  entries: DecisionEntry[];
  superseded: Set<string>;
  supersededBy: Map<string, string>;
} {
  const relFile = normalizeSurfaceRef(
    surfaceRelFile(file),
    SURFACE,
    CONFIG.targets ?? [],
  );
  const { entries: allEntries, superseded } = projectDecisions(
    readLog<DecisionRecord>(LOG_FILE),
  );
  const entries = [...allEntries.values()].filter(
    (e) =>
      normalizeSurfaceRef(e.file, SURFACE, CONFIG.targets ?? []) === relFile,
  );
  return { entries, superseded, supersededBy: supersededByOf(allEntries) };
}

/**
 * Every surface the ledger currently projects onto, plus every one on disk.
 *
 * Read off the projected entries rather than off every recorded `file`. A record's `file` is
 * where the decision lived when that record was written, so one moved to another surface leaves
 * its origin in the log forever. Deriving from history rebuilds that origin as a header-only stub
 * on every render, which reads as an area that still exists and holds nothing.
 */
function allSurfaceFiles(): string[] {
  const { entries } = projectDecisions(readLog<DecisionRecord>(LOG_FILE));
  return impliedSurfaceFiles(
    LEDGER_DIR,
    SURFACE,
    [...entries.values()].map((e) => e.file),
    CONFIG.targets ?? [],
  );
}

/**
 * The entries `list` prints for one surface. Reads the rendered markdown when it exists on
 * disk, and projects straight from the ledger when it does not, so a surface the ledger
 * implies but nothing has rendered yet still reports its live entries.
 */
function listEntries(
  file: string,
): { id: string; title: string; decided: string; status: string }[] {
  if (existsSync(file) && statSync(file).isFile()) {
    return parseEntries(readSurface(file)).map((e) => ({
      id: e.id,
      title: e.title,
      decided: e.meta.Decided ?? todayDate(),
      status: e.meta.Status ?? 'accepted',
    }));
  }
  const { entries, superseded } = projectFileEntries(file);
  return entries.map((e) => ({
    id: e.id,
    title: e.title,
    decided: e.date,
    status: superseded.has(e.id) ? 'superseded' : 'accepted',
  }));
}

/**
 * Rebuilds one surface file from the log alone, in append order.
 *
 * `intentionallyDropped` names ids the log records as no longer belonging to this file, such as
 * a decision `move` sent elsewhere, so the append-only safety check does not mistake that for
 * data loss.
 */
function rerenderFile(
  file: string,
  intentionallyDropped: Set<string> = new Set(),
): void {
  const { entries, superseded, supersededBy } = projectFileEntries(file);
  const body = entries
    .map((e) =>
      renderEntry(
        e,
        superseded.has(e.id) ? 'superseded' : 'accepted',
        supersededBy.get(e.id) ?? null,
      ),
    )
    .join('');
  const nextContent = decisionHeader(file) + body;
  if (rebuildWouldDropEntries(file, nextContent, intentionallyDropped)) {
    console.error(
      `Refusing to rewrite ${relativeToRoot(REPO_ROOT, file)}: the decision ` +
        `ledger at ${LOG_FILE} is missing or has fewer entries than the file ` +
        'already on disk. Rewriting now would destroy the entries it already ' +
        'carries. Decisions are append-only, so the ledger should never hold ' +
        `less than the file it renders. The ledger is committed, so restore it ` +
        `with \`git checkout -- ${relativeToRoot(REPO_ROOT, LOG_FILE)}\`, or ` +
        'copy it from another checkout, then retry.',
    );
    process.exit(1);
  }
  writeFileSync(file, nextContent);
}

function usage() {
  console.error(
    [
      'Usage:',
      '  decision-log.mjs decide    <prefix> <area> <title> [body] [--under <id>]',
      '                             [--supersedes <id>,<id>] [--scope <path>,<path>] [--chat <id>]',
      '  decision-log.mjs supersede <id> <area> <new-title> [body] [--scope <path>,<path>] [--chat <id>]',
      '  decision-log.mjs amend     <id> <area> <new-body>',
      '  decision-log.mjs move      <id> <to-area>',
      '  decision-log.mjs show      <id>',
      '  decision-log.mjs list      [<area>]',
      '  decision-log.mjs render    [<area>]',
      '  decision-log.mjs ancestry  <id>',
      '  decision-log.mjs current   <id>',
      '  decision-log.mjs tree      <id>',
      '  decision-log.mjs scope     <path> [<path>...]',
      '',
      'When [body] is omitted, it is read from stdin.',
      '<area> is required: a bare target name (e.g. studio), resolving to that',
      "area's surface inside the ledger directory, or DECISIONS.md for the repo-root",
      'decisions. A path ending in DECISIONS.md names the same area and resolves to',
      'the same file.',
      'decide/supersede auto-detect the active Claude Code session ID; pass --chat <id> or',
      'set CLAUDE_SESSION_ID=<id> to override, or --chat=none to suppress.',
      'ancestry/current/tree/scope print one line per record, id/title/status, indented by',
      'depth for ancestry and tree. No traversal prints a body; use show for that.',
    ].join('\n'),
  );
}

const argv = process.argv.slice(2);
const chatFlag = takeChatFlag(argv);
const underFlag = takeFlag(argv, 'under');
const supersedesFlag = takeFlag(argv, 'supersedes');
const scopeFlag = takeFlag(argv, 'scope');
const [action, ...rest] = argv;

switch (action) {
  case 'decide': {
    const [prefix, fileArg, title, content] = rest;
    if (!prefix || !fileArg || !title) {
      usage();
      process.exit(1);
    }
    const file = resolveSurfaceFile(fileArg);
    validatePrefix(prefix);
    const body = readContentArg(content);
    if (!body) {
      console.error(
        'Empty body. Pass content as the 4th arg or pipe via stdin.',
      );
      process.exit(1);
    }
    const { entries, superseded } = projectDecisions(
      readLog<DecisionRecord>(LOG_FILE),
    );
    const supersedeIds = splitList(supersedesFlag);
    const scope = splitList(scopeFlag);
    const ts = nowIso();
    const id = makeId(prefix, title, ts);
    if (underFlag) {
      requireKnownId(entries, underFlag, '--under');
      requireNoUnderCycle(entries, id, underFlag);
    }
    for (const target of supersedeIds) {
      requireKnownId(entries, target, '--supersedes');
      requireAccepted(superseded, target, '--supersedes');
    }
    const chat = resolveChat(chatFlag, REPO_ROOT);
    const relFile = surfaceRelFile(file);
    appendEvent(LOG_FILE, {
      ts,
      id,
      action: 'decide',
      file: relFile,
      title,
      ...(underFlag ? { under: underFlag } : {}),
      ...(supersedeIds.length ? { supersedes: supersedeIds } : {}),
      ...(scope.length ? { scope } : {}),
      chat,
      content: encodeBody(body),
    });
    rerenderFile(file);
    console.log(id);
    if (chat) console.log(`chat: ${chat}`);
    else if (chatFlag !== 'none')
      console.error(
        'warning: no active Claude session detected; entry written without chat ID.',
      );
    break;
  }

  case 'supersede': {
    const [targetId, fileArg, newTitle, content] = rest;
    if (!targetId || !fileArg || !newTitle) {
      usage();
      process.exit(1);
    }
    const file = resolveSurfaceFile(fileArg);
    const body = readContentArg(content);
    if (!body) {
      console.error(
        'Empty body. Pass content as the 4th arg or pipe via stdin.',
      );
      process.exit(1);
    }
    const { entries, superseded } = projectDecisions(
      readLog<DecisionRecord>(LOG_FILE),
    );
    requireKnownId(entries, targetId, 'supersede');
    requireAccepted(superseded, targetId, 'supersede');
    const prefix = targetId.split('-')[0];
    const scope = splitList(scopeFlag);
    const ts = nowIso();
    const id = makeId(prefix, newTitle, ts);
    const chat = resolveChat(chatFlag, REPO_ROOT);
    const relFile = surfaceRelFile(file);
    appendEvent(LOG_FILE, {
      ts,
      id,
      action: 'supersede',
      file: relFile,
      title: newTitle,
      supersedes: [targetId],
      ...(scope.length ? { scope } : {}),
      chat,
      content: encodeBody(body),
    });
    rerenderFile(file);
    console.log(id);
    if (chat) console.log(`chat: ${chat}`);
    else if (chatFlag !== 'none')
      console.error(
        'warning: no active Claude session detected; entry written without chat ID.',
      );
    break;
  }

  case 'amend': {
    const [id, fileArg, content] = rest;
    if (!id || !fileArg) {
      usage();
      process.exit(1);
    }
    const file = resolveSurfaceFile(fileArg);
    const body = readContentArg(content);
    if (!body) {
      console.error(
        'Empty body. Pass content as the 3rd arg or pipe via stdin.',
      );
      process.exit(1);
    }
    const { entries } = projectDecisions(readLog<DecisionRecord>(LOG_FILE));
    requireKnownId(entries, id, 'amend');
    const chat = resolveChat(chatFlag, REPO_ROOT);
    const relFile = surfaceRelFile(file);
    appendEvent(LOG_FILE, {
      ts: nowIso(),
      id,
      action: 'amend',
      file: relFile,
      chat,
      content: encodeBody(body),
    });
    rerenderFile(file);
    break;
  }

  case 'move': {
    const [id, toArea] = rest;
    if (!id || !toArea) {
      usage();
      process.exit(1);
    }
    const { entries } = projectDecisions(readLog<DecisionRecord>(LOG_FILE));
    requireKnownId(entries, id, 'move');
    const oldFile = resolve(LEDGER_DIR, entries.get(id)!.file);
    const newFile = resolveSurfaceFile(toArea);
    const chat = resolveChat(chatFlag, REPO_ROOT);
    appendEvent(LOG_FILE, {
      ts: nowIso(),
      id,
      action: 'move',
      file: surfaceRelFile(newFile),
      chat,
    });
    rerenderFile(oldFile, new Set([id]));
    rerenderFile(newFile);
    break;
  }

  case 'show': {
    const [id] = rest;
    if (!id) {
      usage();
      process.exit(1);
    }
    if (!existsSync(LOG_FILE)) {
      console.error('No decision log yet.');
      process.exit(0);
    }
    let found = 0;
    for (const r of readLog<DecisionRecord>(LOG_FILE)) {
      if (r.id !== id) continue;
      found++;
      console.log(
        `[${r.ts}] ${r.action}${r.title ? ` — ${r.title}` : ''}${r.file ? ` (${r.file})` : ''}`,
      );
      if (r.chat) console.log(`chat: ${r.chat}`);
      if (r.supersedes?.length)
        console.log(`supersedes: ${r.supersedes.join(', ')}`);
      if (r.under) console.log(`under: ${r.under}`);
      if (r.scope?.length) console.log(`scope: ${r.scope.join(', ')}`);
      if (r.content) console.log(decodeBody(r.content));
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
    const files = file ? [resolveSurfaceFile(file)] : allSurfaceFiles();
    for (const f of files) {
      const entries = listEntries(f);
      if (!entries.length) continue;
      console.log(`# ${relativeToRoot(REPO_ROOT, f)}`);
      for (const e of entries) {
        console.log(`  ${e.id}  ${e.decided}  ${e.status}  ${e.title}`);
      }
      console.log('');
    }
    break;
  }

  case 'render': {
    const [file] = rest;
    const files = file ? [resolveSurfaceFile(file)] : allSurfaceFiles();
    for (const f of files) rerenderFile(f);
    break;
  }

  case 'ancestry': {
    const [id] = rest;
    if (!id) {
      usage();
      process.exit(1);
    }
    const { entries, superseded } = projectDecisions(
      readLog<DecisionRecord>(LOG_FILE),
    );
    requireKnownId(entries, id, 'ancestry');
    const walk = (nodeId: string, depth: number): void => {
      const e = entries.get(nodeId);
      if (!e) return;
      printEntryLine(e, superseded, depth);
      for (const parent of e.supersedes) walk(parent, depth + 1);
    };
    walk(id, 0);
    break;
  }

  case 'current': {
    const [id] = rest;
    if (!id) {
      usage();
      process.exit(1);
    }
    const { entries, superseded } = projectDecisions(
      readLog<DecisionRecord>(LOG_FILE),
    );
    requireKnownId(entries, id, 'current');
    const supersededBy = supersededByOf(entries);
    let nodeId: string | undefined = id;
    while (nodeId) {
      const e: DecisionEntry | undefined = entries.get(nodeId);
      if (!e) break;
      printEntryLine(e, superseded, 0);
      nodeId = supersededBy.get(nodeId);
    }
    break;
  }

  case 'tree': {
    const [id] = rest;
    if (!id) {
      usage();
      process.exit(1);
    }
    const { entries, superseded } = projectDecisions(
      readLog<DecisionRecord>(LOG_FILE),
    );
    requireKnownId(entries, id, 'tree');
    const children = underChildrenOf(entries);
    const walk = (nodeId: string, depth: number): void => {
      const e = entries.get(nodeId);
      if (!e) return;
      printEntryLine(e, superseded, depth);
      for (const child of children.get(nodeId) ?? []) walk(child, depth + 1);
    };
    walk(id, 0);
    break;
  }

  case 'scope': {
    const paths = rest;
    if (!paths.length) {
      usage();
      process.exit(1);
    }
    const { entries, superseded } = projectDecisions(
      readLog<DecisionRecord>(LOG_FILE),
    );
    const queries = paths.map(normalizeScopePath);
    for (const e of entries.values()) {
      if (
        e.scope.some((p) =>
          queries.some((q) => scopesOverlap(normalizeScopePath(p), q)),
        )
      )
        printEntryLine(e, superseded, 0);
    }
    break;
  }

  default:
    usage();
    process.exit(action ? 1 : 0);
}
