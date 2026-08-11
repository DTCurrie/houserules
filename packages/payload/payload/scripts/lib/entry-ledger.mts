import { gzipSync, gunzipSync } from 'node:zlib';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';

import { ENTRY_HEAD } from './backlog-id.mjs';

export const SEPARATOR = '---';

const TRANSCRIPT_TAIL_BYTES = 16384;
const METADATA_LINE = /^\*\*([A-Za-z][A-Za-z ]*):\*\*\s+(.+)$/;
const METADATA_JOIN = ' · ';

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
      const line = lines[i];
      if (line === undefined) continue;
      try {
        return JSON.parse(line);
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

/**
 * The append-only ledger for `name`, at `.claude/ledgers/<name>.jsonl`.
 *
 * Its own directory rather than `.claude/state/`, which the changesets module already owns for
 * ephemeral cache and self-gitignores with `*` because none of it needs to survive being
 * deleted. The ledger is a local write-ahead queue that `projects-sync.mjs push` drains to
 * GitHub Projects, so an entry not yet pushed exists nowhere else, and the two directories need
 * different ignore rules and cannot share one. `.jsonl` and not `.log`, because `*.log` is a
 * common ignore pattern this file must avoid.
 *
 * Older trees are migrated in place, newest layout first, so there is one path afterwards and
 * never a split ledger. A rename that fails leaves the older file authoritative rather than
 * starting a second one.
 */
export function ledgerPath(
  repoRoot: string,
  name: string,
  configuredDir?: string,
): string {
  const current = resolve(ledgerDir(repoRoot, configuredDir), `${name}.jsonl`);
  if (existsSync(current)) return current;
  // Unconditionally, not only when migrating. A fresh install has no legacy file to move, and
  // the first append would otherwise fail with ENOENT on a directory nothing had created.
  try {
    mkdirSync(dirname(current), { recursive: true });
  } catch {
    // A caller that cannot create the directory also cannot write the ledger. Let the write
    // report that, rather than failing here with less context.
  }
  for (const legacy of [
    resolve(repoRoot, `.claude/${name}.jsonl`),
    resolve(repoRoot, `.claude/${name}.log`),
  ]) {
    if (!existsSync(legacy)) continue;
    try {
      renameSync(legacy, current);
      return current;
    } catch {
      return legacy;
    }
  }
  return current;
}

/**
 * Whether replacing `file` with `nextContent` would drop entries the file already holds and
 * the ledger does not account for.
 *
 * A rebuild reads the ledger and overwrites the surface, so a missing ledger silently destroys
 * the only remaining copy. Measured, not assumed: a checkout carrying the surface without its
 * ledger turned four recorded decisions into one.
 *
 * Compares id SETS, not counts. A count check cannot tell a legitimate removal from the loss
 * of a different entry, and it misses the case where one entry vanishes as another appears.
 * `intentionallyDropped` is the ids the ledger records as removed, which a backlog removal
 * produces and a decision never does, since superseding leaves the entry rendered.
 */
export function rebuildWouldDropEntries(
  file: string,
  nextContent: string,
  intentionallyDropped: ReadonlySet<string> = new Set(),
): boolean {
  const before = parseEntries(readSurface(file));
  if (before.length === 0) return false;
  const after = new Set(parseEntries(nextContent).map((e) => e.id));
  return before.some(
    (e) => !after.has(e.id) && !intentionallyDropped.has(e.id),
  );
}

export function readSurface(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
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

export const DEFAULT_LEDGER_DIR = '.claude/ledgers';

/**
 * The ledger directory, from `ledgers.dir` or the default.
 *
 * Falls back to the default for a path that escapes the repo, and for the repo root itself. The
 * root is refused because the kit self-ignores this directory with `*.md`, and that rule at the
 * repo root would hide README.md, CLAUDE.md, and every other document in the project.
 */
export function ledgerDir(repoRoot: string, configured?: string): string {
  const root = resolve(repoRoot);
  const fallback = resolve(root, DEFAULT_LEDGER_DIR);
  const dir = resolve(root, configured || DEFAULT_LEDGER_DIR);
  if (dir === root) return fallback;
  return dir.startsWith(`${root}/`) ? dir : fallback;
}

/**
 * Where one area's rendered surface lives, as `<dir>/<target>.<basename>`.
 *
 * A monorepo separates areas by filename inside one ledger directory rather than by nesting a
 * ledger beside each package. One directory per repo means one place to find, ignore, and
 * reconcile, and the record's own `file` field already says which surface an entry belongs to.
 * The root area has no prefix, so it stays `BACKLOG.md`.
 */
export function surfacePath(
  dir: string,
  basename: string,
  target?: string | null,
): string {
  return resolve(dir, target ? `${target}.${basename}` : basename);
}

/**
 * Whether a surface with zero live entries should be deleted rather than left as a bare header.
 *
 * A surface is written for any area the ledger has ever recorded against, so an area whose
 * entries were all removed kept rendering as a header-only stub that no `remove` could ever
 * clear. The repo-root area collects every entry logged without an `<area>`, which makes it the
 * one that accumulates stubs by accident.
 *
 * A configured target is exempt. Its surface is declared in `kit.config.json`, so an empty one
 * reads as "this area has nothing open" rather than as residue, and deleting it would churn a
 * file the repo means to have. An area with no target and no entries is residue, so it goes.
 */
export function surfaceIsResidue(
  file: string,
  basename: string,
  entryCount: number,
  targets: readonly { name?: string }[],
): boolean {
  if (entryCount > 0) return false;
  const name = file.split('/').pop() ?? '';
  if (name === basename) return true;
  const target = name.slice(0, -(basename.length + 1));
  return !targets.some((t) => t.name === target);
}

/**
 * The area a rendered surface covers, for its header. Reads the target out of the filename and
 * maps it through the configured targets, so a file named `studio.BACKLOG.md` renders as
 * `Backlog — Studio` rather than naming the directory it happens to sit in.
 *
 * The target's `label` wins over its `pathPrefix`. A surface named for a target does not have to
 * hold only that target's entries: a repo whose whole product is one target files everything
 * there, and rendering `pathPrefix` then claims a scope narrower than the entries below it. The
 * label is the name the user chose for the area, so it stays true either way. `pathPrefix`
 * remains the fallback for a target that somehow carries no label.
 */
export function surfaceScope(
  file: string,
  basename: string,
  targets: ReadonlyArray<{ name: string; label?: string; pathPrefix?: string }>,
): string {
  const name = file.split('/').pop() ?? '';
  if (name === basename) return 'repo root';
  const target = name.slice(0, -(basename.length + 1));
  const match = targets.find((t) => t.name === target);
  return match?.label || match?.pathPrefix?.replace(/\/$/, '') || target;
}

/**
 * The path recorded on each entry's `file`, and matched against when rebuilding a surface.
 *
 * Relative to the LEDGER DIRECTORY, never the repo root. Two reasons, both load-bearing. A
 * record written when the surface sat at the repo root says `BACKLOG.md`, and that keeps
 * matching once the surface moves into the ledger directory, so no migration is needed. And
 * moving the directory later through `ledgers.dir` does not orphan every existing record.
 *
 * Recording this against the repo root instead silently renders an empty surface: the filter
 * compares `.claude/ledgers/BACKLOG.md` to a stored `BACKLOG.md` and matches nothing.
 */
export function surfaceRelFile(dir: string, file: string): string {
  return relative(dir, resolve(file));
}

/**
 * Collapses a surface name that carries its basename more than once down to a single copy.
 *
 * `tower-push.DECISIONS.md` is the surface for the `tower-push` area, so passing that whole
 * name where an area was expected glued a second basename on and produced
 * `tower-push.DECISIONS.md.DECISIONS.md`. Nothing rejected it, the name has no separator, and
 * a name with no separator reads as a legitimate area, so the doubled surface rendered as a
 * distinct file and split one area's entries across two.
 *
 * Only a genuine repeat is collapsed. A name carrying the basename once is already canonical,
 * and a bare area name is left alone for the caller to glue.
 */
function collapseRepeatedSuffix(name: string, basename: string): string {
  const suffix = `.${basename}`;
  let collapsed = name;
  while (collapsed.endsWith(`${suffix}${suffix}`))
    collapsed = collapsed.slice(0, -suffix.length);
  return collapsed;
}

/**
 * The ledger-dir-relative surface name a recorded `file` value refers to today.
 *
 * Ledgers written before the surfaces moved into the ledger directory recorded a repo-relative
 * path such as `games/tower-push/BACKLOG.md`. Nothing can equal that today, because
 * {@link surfaceRelFile} now yields `tower-push.BACKLOG.md`, so every such entry silently stops
 * matching its surface and the ledger renders empty.
 *
 * Normalizing on READ rather than rewriting the ledger is deliberate. The ledger is append-only,
 * so a migration that rewrote historical `file` fields would edit records already appended and
 * possibly already pushed to the board. This is a pure projection instead, it is idempotent,
 * and a repo can roll back to an older kit without its history having been altered.
 *
 * The area is taken from the configured targets first, since that is authoritative. The trailing
 * directory name is the fallback, which is what makes an area the config no longer lists still
 * resolve rather than vanish.
 *
 * @param recorded The `file` value as stored on the entry.
 * @param basename The surface basename, `BACKLOG.md` or `DECISIONS.md`.
 */
export function normalizeSurfaceRef(
  recorded: string,
  basename: string,
  targets: ReadonlyArray<{ name: string; pathPrefix?: string }>,
): string {
  const clean = collapseRepeatedSuffix(recorded.replace(/^\.\//, ''), basename);
  if (!clean.includes('/')) return clean;
  if (!clean.endsWith(`/${basename}`)) return clean;

  const dir = clean.slice(0, -(basename.length + 1));
  const match = targets.find(
    (target) => (target.pathPrefix ?? '').replace(/\/+$/, '') === dir,
  );
  const area = match?.name ?? dir.split('/').filter(Boolean).pop();
  return area ? `${area}.${basename}` : clean;
}

/**
 * Resolves the `<area>` argument the ledger commands accept, one rule for every ledger.
 *
 * Omitted, or the basename itself, means the repo-root surface inside the ledger directory. A
 * bare word names an area. A path ending in the surface basename names an area too, and routes
 * to the same canonical file the bare word would. So does an area's own surface filename, so
 * `tower-push` and `tower-push.BACKLOG.md` are one area rather than two.
 *
 * That last rule is why this takes `targets`. The argument goes through
 * {@link normalizeSurfaceRef}, the same projection the rebuild uses to decide which entries
 * belong to a surface, so the file written is always the file the projection matched. While the
 * two disagreed, `remove <id> games/tower-push/BACKLOG.md` rebuilt the surface into a stray file
 * and left the canonical one still carrying the entry it had just removed, at exit code 0.
 *
 * Anything else with a separator stays an explicit path, resolved against the repo root rather
 * than the process cwd, so a hook invoked from a subdirectory writes where the caller meant. A
 * literal path that escapes the repo falls back to the root surface, the way {@link ledgerDir}
 * refuses an escaping `ledgers.dir`, since no ledger command has reason to write outside the
 * repo it is recording.
 *
 * Lives here rather than in each script because the two ledgers diverged when they each owned a
 * copy: one sent the bare basename to the repo root and the other to the ledger directory, so the
 * same argument meant two different files.
 */
export function resolveSurfaceArg(
  repoRoot: string,
  dir: string,
  basename: string,
  targets: ReadonlyArray<{ name: string; pathPrefix?: string }>,
  arg?: string,
): string {
  if (!arg || arg === basename) return surfacePath(dir, basename, null);
  if (!arg.includes('/')) {
    const collapsed = collapseRepeatedSuffix(arg, basename);
    return collapsed.endsWith(`.${basename}`)
      ? resolve(dir, collapsed)
      : surfacePath(dir, basename, collapsed);
  }

  const normalized = normalizeSurfaceRef(arg, basename, targets);
  if (!normalized.includes('/')) return resolve(dir, normalized);

  const root = resolve(repoRoot);
  const literal = resolve(root, arg);
  return literal.startsWith(`${root}/`)
    ? literal
    : surfacePath(dir, basename, null);
}

/**
 * The bare area name an `<area>` argument refers to, or null when {@link resolveSurfaceArg} would
 * not resolve it against a per-target surface at all: the repo-root surface, or a literal path
 * escape hatch, meaning a path with a separator that does not name a configured target's area.
 *
 * Mirrors {@link resolveSurfaceArg}'s branching on the same argument, so a name checked here is the
 * name the surface would actually resolve to.
 */
export function resolveAreaName(
  arg: string,
  basename: string,
  targets: ReadonlyArray<{ name: string; pathPrefix?: string }>,
): string | null {
  if (!arg || arg === basename) return null;
  const normalized = normalizeSurfaceRef(arg, basename, targets);
  if (normalized === basename) return null;
  if (normalized.includes('/')) return null;
  return normalized.endsWith(`.${basename}`)
    ? normalized.slice(0, -(basename.length + 1))
    : normalized;
}

/**
 * The area names a list of surface files stands for, skipping the repo-root surface.
 *
 * Takes the file list rather than reading the directory, so this stays pure and the script that
 * already knows its surfaces is the one that supplies them.
 */
export function areaNamesOf(
  surfaceFiles: readonly string[],
  dir: string,
  basename: string,
  targets: ReadonlyArray<{ name: string; pathPrefix?: string }>,
): Set<string> {
  const names = new Set<string>();
  for (const file of surfaceFiles) {
    const area = resolveAreaName(surfaceRelFile(dir, file), basename, targets);
    if (area !== null) names.add(area);
  }
  return names;
}

/**
 * Why this `<area>` argument cannot be used, or null when it names an area that exists.
 *
 * Every ledger command that takes an area calls this BEFORE it appends or renders anything. An area
 * nothing knows about is not a harmless typo. It renders a surface file nobody asked for, and the
 * ledger then carries entries filed against a surface no board is configured for, so the mistake
 * surfaces one or more pushes later as `no board configured for surface "<area>.BACKLOG.md"`, far
 * from the command that caused it.
 *
 * An area counts as existing if a target configures it OR a surface for it is already on disk.
 * `existingAreas` is what carries the second half, and dropping it would break the fallback
 * {@link normalizeSurfaceRef} exists for: an area whose target the config no longer lists still
 * has its entries, and `render <that area>` has to keep resolving rather than being called a typo.
 * A genuine typo matches neither half.
 *
 * Returns the message rather than exiting, because the two ledger scripts own their own exits. It
 * returns the message rather than a boolean so the wording cannot drift between them, which is the
 * same reason {@link resolveSurfaceArg} lives here.
 */
export function unknownAreaMessage(
  arg: string | undefined,
  basename: string,
  targets: ReadonlyArray<{ name: string; pathPrefix?: string }>,
  existingAreas: ReadonlySet<string>,
): string | null {
  if (!arg) return null;
  const area = resolveAreaName(arg, basename, targets);
  if (area === null || existingAreas.has(area)) return null;
  if (targets.some((target) => target.name === area)) return null;

  const valid = [
    '(repo root)',
    ...new Set([...targets.map((target) => target.name), ...existingAreas]),
  ];
  return (
    `Unknown area "${arg}". No target named "${area}" is configured in kit.config.json, ` +
    `and no surface for it exists yet.\n` +
    `Valid areas: ${valid.join(', ')}.`
  );
}

/**
 * Every surface the ledger implies, union'd with every surface already on disk.
 *
 * The `.jsonl` is the source of truth and the markdown is a generated view, so a freshly
 * migrated ledger, one whose entries moved into `.claude/ledgers/` but was never rendered,
 * has zero files on disk and would otherwise look empty to `list` and `render`. Deriving the
 * surface set from the ledger's own recorded `file` values instead means a surface with no
 * live entries still gets its header, and a surface every entry was removed from does not
 * silently vanish just because nothing wrote it since.
 *
 * On-disk names go through the same projection as the recorded ones. A file left behind under
 * a name that no longer projects to itself, such as a doubled `x.BACKLOG.md.BACKLOG.md`, would
 * otherwise be rebuilt on every render with the content of the area it collapses to, leaving
 * two files holding the same entries.
 *
 * @param recordedFiles The raw `file` value off every ledger record, in any order, possibly
 *   holding `undefined` for records that predate the field.
 */
export function impliedSurfaceFiles(
  dir: string,
  basename: string,
  recordedFiles: Iterable<string | undefined>,
  targets: ReadonlyArray<{ name: string; pathPrefix?: string }>,
): string[] {
  const names = new Set<string>();
  for (const recorded of recordedFiles) {
    if (recorded) names.add(normalizeSurfaceRef(recorded, basename, targets));
  }
  for (const file of findSurfaceFiles(dir, basename)) {
    names.add(normalizeSurfaceRef(relative(dir, file), basename, targets));
  }
  return [...new Set([...names].map((name) => resolve(dir, name)))].sort();
}

/** Every rendered surface with this basename in the ledger directory. */
export function findSurfaceFiles(dir: string, basename: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    // A read failure looks identical to "nothing rendered yet" to this function's return
    // shape, so the diagnostic goes to stderr, distinguishable from a fresh ledger directory.
    console.error(
      `agent-kit: could not read ledger directory ${dir}: ${(e as Error).message}`,
    );
    return [];
  }
  return entries
    .filter(
      (e) =>
        e.isFile() && (e.name === basename || e.name.endsWith(`.${basename}`)),
    )
    .map((e) => resolve(dir, e.name))
    .sort();
}

/** `**Label:** value` pairs on one line, which may carry several joined by ` · `. */
function metadataOf(line: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const segment of line.split(METADATA_JOIN)) {
    const m = segment.trim().match(METADATA_LINE);
    // METADATA_LINE has two non-optional capture groups, so a match always fills both.
    if (m) pairs.push([m[1]!, m[2]!.trim()]);
  }
  return pairs;
}

export function renderMetadata(fields: Record<string, string | null>): string {
  return Object.entries(fields)
    .filter(([, v]) => v)
    .map(([k, v]) => `**${k}:** ${v}`)
    .join('\n');
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
      // ENTRY_HEAD has two non-optional capture groups, so a match always fills both.
      current = { id: m[1]!, title: m[2]!, meta: {}, body: [] };
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
