#!/usr/bin/env node
/**
 * Stop hook. Structural gates over the changesets houserules itself writes.
 *
 * Three checks, each covering one MECHANICAL clause from the `changeset` and
 * `changeset-condense` skills that survived the determinism audit:
 *
 *   h5 — a newly-written pending changeset's declared package set has drifted from what
 *        the current diff actually touches ("the package set grew").
 *   h6 — a major bump was written without a proposal, then a user turn, before the write
 *        call ("Confirm with the user before recording a major").
 *   h9 — `changeset-write.mjs --absorb` ran without a proposal, then a user turn, before
 *        the call ("Propose, then confirm... Wait for approval").
 *
 * h6 and h9 read `transcript_path` off the Stop hook payload and are silent when it is
 * absent, since ordering has nothing to check without a transcript.
 *
 * Exit 2 with the report on stderr when a gate is violated. Every failure path exits 0,
 * because a nudge hook must never break a session.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { listWorkspacePackages } from '@houserules/payload/workspaces';
import { git, readStdinJson, repoRoot } from '@houserules/payload/proc';
import {
  emptyReport,
  hasErrors,
  renderReport,
  type Finding,
  type Report,
} from '@houserules/payload/findings';

const DECLINED = [
  'whether two changesets describe the same feature — feature identity is a reading-comprehension judgment the changeset skill keeps',
  'whether a major/minor/patch level is the RIGHT level for a change — semver judgment stays in the skill',
  'the accuracy of a proposal message shown before an absorb or a major bump — only that a proposal and a user turn happened before the call, never whether the proposal was correct',
];

const CHANGESET_MD = /\.changeset\/[^/]+\.md$/;

function isChangesetMd(path: string): boolean {
  return CHANGESET_MD.test(`/${path}`) && !/\/readme\.md$/i.test(path);
}

const RELEASE_LINE = /^\s*['"]?([^'"]+?)['"]?\s*:\s*(patch|minor|major)\s*$/;

/** Package names an already-written changeset file declares. */
export function parseDeclaredPackages(content: string): string[] {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return [];
  const names: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const match = RELEASE_LINE.exec(line);
    if (match) names.push(match[1]!);
  }
  return names;
}

export interface PendingChangeset {
  id: string;
  declaredPkgs: string[];
}

/**
 * h5. Flags a pending changeset (one written this turn, not an already-settled one) whose
 * declared packages are missing one the current diff touches.
 */
/**
 * Reports a package the diff touches that **no** pending changeset declares.
 *
 * The union matters. Comparing each changeset against the whole diff individually treats every
 * sibling changeset as drift, so a repo with one changeset per package reports every one of them
 * as wrong forever. That is what happened the first time this gate ran for real, against 16
 * pending first-release changesets.
 */
export function checkPackageDrift(
  pending: PendingChangeset[],
  touchedPkgs: string[],
): Report {
  const report = emptyReport();
  if (pending.length === 0) return report;
  const covered = new Set(pending.flatMap((cs) => cs.declaredPkgs));
  const missing = touchedPkgs.filter((p) => !covered.has(p));
  if (missing.length === 0) return report;
  report.findings.push({
    rule: 'changeset-gate/h5-package-drift',
    level: 'error',
    file: `.changeset/${pending[0]!.id}.md`,
    line: null,
    msg: `No pending changeset declares ${missing.join(', ')}, which the current diff touches. Amend the changeset covering this feature, or add one.`,
  });
  return report;
}

interface TranscriptContentBlock {
  type?: string;
  text?: string;
  input?: { command?: string };
}

interface TranscriptEntry {
  type?: string;
  message?: { content?: TranscriptContentBlock[] };
}

/** Parses a Claude Code transcript (JSONL). Malformed lines are skipped, never thrown on. */
export function parseTranscript(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      continue;
    }
  }
  return entries;
}

interface OrderingGate {
  rule: string;
  msg: string;
  matches: (bashCommand: string) => boolean;
}

const ORDERING_GATES: OrderingGate[] = [
  {
    rule: 'changeset-gate/h6-major-confirm',
    msg: 'changeset-write ran a major bump with no proposal followed by a user turn before the call.',
    matches: (cmd) =>
      /changeset-write(\.mjs)?\b/.test(cmd) &&
      (/:major\b/.test(cmd) || /--level[= ]major\b/.test(cmd)),
  },
  {
    rule: 'changeset-gate/h9-absorb-order',
    msg: 'changeset-write --absorb ran with no proposal followed by a user turn before the call.',
    matches: (cmd) =>
      /changeset-write(\.mjs)?\b/.test(cmd) && /--absorb\b/.test(cmd),
  },
];

/**
 * Findings for one tool-use command, given whether a proposal has been made and confirmed.
 *
 * Split out of `checkTranscriptOrdering` so the gate loop reads at one level. The caller
 * owns the propose/confirm state machine, this only judges a single command against it.
 */
function orderingFindingsFor(
  command: string,
  proposed: boolean,
  confirmedSinceProposal: boolean,
): Finding[] {
  if (proposed && confirmedSinceProposal) return [];
  return ORDERING_GATES.filter((gate) => gate.matches(command)).map((gate) => ({
    rule: gate.rule,
    level: 'error' as const,
    file: 'transcript',
    line: null,
    msg: gate.msg,
  }));
}

/**
 * h6 and h9. A gate call is a violation unless, earlier in the same transcript, an
 * assistant text block appeared AND a user message followed it before this call. That is
 * the structural shape of "propose, then confirm, then act" — a same-turn call with no
 * intervening user turn never got a chance to be approved.
 */
export function checkTranscriptOrdering(entries: TranscriptEntry[]): Report {
  const report = emptyReport();
  let proposed = false;
  let confirmedSinceProposal = false;

  for (const entry of entries) {
    const blocks = entry.message?.content ?? [];
    if (entry.type === 'user') {
      if (proposed) confirmedSinceProposal = true;
      continue;
    }
    if (entry.type !== 'assistant') continue;
    for (const block of blocks) {
      if (block.type === 'text' && block.text?.trim()) {
        proposed = true;
        confirmedSinceProposal = false;
      } else if (block.type === 'tool_use' && block.input?.command) {
        report.findings.push(
          ...orderingFindingsFor(
            block.input.command,
            proposed,
            confirmedSinceProposal,
          ),
        );
      }
    }
  }
  return report;
}

function readPendingChangesets(root: string): Map<string, string> {
  const dir = join(root, '.changeset');
  const byId = new Map<string, string>();
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md') || /^readme\.md$/i.test(file)) continue;
      byId.set(
        file.replace(/\.md$/, ''),
        readFileSync(join(dir, file), 'utf8'),
      );
    }
  } catch {
    // no .changeset/ dir yet
  }
  return byId;
}

function newChangesetIds(root: string): Set<string> {
  const ids = new Set<string>();
  const status = git(root, ['status', '--porcelain']) ?? '';
  for (const line of status.split('\n').filter(Boolean)) {
    const path = line.slice(3).trim().replace(/^"|"$/g, '');
    if (isChangesetMd(path))
      ids.add(path.split('/').pop()!.replace(/\.md$/, ''));
  }
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
  if (
    branch &&
    branch !== 'main' &&
    git(root, ['rev-parse', '--verify', '--quiet', 'main']) !== null
  ) {
    const nameStatus = (
      git(root, ['diff', '--name-status', 'main...HEAD']) ?? ''
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'));
    for (const fields of nameStatus) {
      const status = fields[0];
      const path = fields[fields.length - 1];
      if (status?.startsWith('A') && path && isChangesetMd(path)) {
        ids.add(path.split('/').pop()!.replace(/\.md$/, ''));
      }
    }
  }
  return ids;
}

/**
 * True for a path whose change cannot reach a published package.
 *
 * Tests are excluded from every package's `dist` and `payload-dist` by its build tsconfig, so a
 * package whose only diff is a test ships identical bytes and needs no changeset entry. Counting
 * it produced a false positive the first time this gate ran for real: `plugin-backlog` was
 * reported as drift on the strength of a single edited test file.
 *
 * tsconfigs are excluded the same way: they configure the compiler and are not `files` entries.
 * An `exclude` edit CAN change what `dist/` emits, so this trades that rare false negative for
 * the common false positive, a repo-wide tsconfig sweep reporting every package as drift.
 */
function shipsNothing(path: string): boolean {
  return (
    /(^|\/)__tests?__\//.test(path) ||
    /\.test\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)tsconfig[^/]*\.json$/.test(path)
  );
}

/**
 * True when `path` is a package.json whose only difference from `ref` is its `wireit` block.
 *
 * Wireit config (dependency graph, input globs) never changes what a consumer of the published
 * tarball observes, and a repo-wide glob rename otherwise reports every package as drift. A file
 * git cannot show at `ref`, or that does not parse on either side, counts as a real change.
 */
function wireitOnlyEdit(
  root: string,
  path: string,
  ref: string | null,
): boolean {
  if (!ref || !/(^|\/)package\.json$/.test(path)) return false;
  const before = git(root, ['show', `${ref}:${path}`]);
  if (before === null) return false;
  let pair: [Record<string, unknown>, Record<string, unknown>];
  try {
    pair = [
      JSON.parse(before) as Record<string, unknown>,
      JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<
        string,
        unknown
      >,
    ];
  } catch {
    return false;
  }
  for (const pkg of pair) delete pkg.wireit;
  return JSON.stringify(pair[0]) === JSON.stringify(pair[1]);
}

// npm packs these package-root files regardless of `files` (any case, any extension).
const ALWAYS_PACKED =
  /^(readme|license|licence|notice|copying|changelog|changes|history)(\.|$)/i;

/**
 * True for a package-root markdown file the published tarball cannot contain.
 *
 * npm packs a root doc only when `files` names it (the CLI ships CONVENTIONS.md that way) or
 * when npm always includes it (README, LICENSE, CHANGELOG and their variants). Anything else
 * at the package root, most commonly a CLAUDE.md, is repo documentation: it ships no bytes,
 * so it owes no changeset entry. A `files` entry is matched by exact name. A glob that
 * happens to cover the doc is the same rare false negative the tsconfig exclusion above
 * already trades for, and a package with no `files` list packs everything, so its docs count.
 */
function unshippedRootDoc(root: string, path: string, relDir: string): boolean {
  const name = path.startsWith(`${relDir}/`)
    ? path.slice(relDir.length + 1)
    : path;
  if (name.includes('/') || !/\.md$/i.test(name) || ALWAYS_PACKED.test(name))
    return false;
  try {
    const pkg = JSON.parse(
      readFileSync(join(root, relDir, 'package.json'), 'utf8'),
    ) as { files?: unknown };
    if (!Array.isArray(pkg.files)) return false;
    return !pkg.files.some(
      (entry) =>
        typeof entry === 'string' &&
        entry.replace(/^\.\//, '').replace(/\/$/, '') === name,
    );
  } catch {
    return false;
  }
}

function touchedPackages(root: string): string[] {
  const pkgs = listWorkspacePackages(root);
  const status = git(root, ['status', '--porcelain']) ?? '';
  const dirty = status
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim().replace(/^"|"$/g, ''));
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
  let committed: string[] = [];
  let mergeBase: string | null = null;
  if (
    branch &&
    branch !== 'main' &&
    git(root, ['rev-parse', '--verify', '--quiet', 'main']) !== null
  ) {
    committed = (git(root, ['diff', '--name-only', 'main...HEAD']) ?? '')
      .split('\n')
      .filter(Boolean);
    mergeBase = git(root, ['merge-base', 'main', 'HEAD'])?.trim() ?? null;
  }
  // A branch-committed path diffs against the merge base, a merely-dirty one against HEAD.
  const committedSet = new Set(committed);
  const touched = [...dirty, ...committed].filter(
    (p) =>
      !isChangesetMd(p) &&
      !shipsNothing(p) &&
      !wireitOnlyEdit(root, p, committedSet.has(p) ? mergeBase : 'HEAD'),
  );
  const names = new Set<string>();
  for (const path of touched) {
    const owner = pkgs.find(
      (pkg) => path === pkg.relDir || path.startsWith(`${pkg.relDir}/`),
    );
    if (owner && !unshippedRootDoc(root, path, owner.relDir))
      names.add(owner.name);
  }
  return [...names];
}

function main(): void {
  const input = readStdinJson<{
    stop_hook_active?: boolean;
    transcript_path?: string;
  }>();
  if (input.stop_hook_active) process.exit(0);

  try {
    const root = repoRoot();
    const report = emptyReport();
    report.declined.push(...DECLINED);

    const pendingFiles = readPendingChangesets(root);
    const newIds = newChangesetIds(root);
    const pending: PendingChangeset[] = [...newIds]
      .filter((id) => pendingFiles.has(id))
      .map((id) => ({
        id,
        declaredPkgs: parseDeclaredPackages(pendingFiles.get(id)!),
      }));
    report.findings.push(
      ...checkPackageDrift(pending, touchedPackages(root)).findings,
    );

    if (input.transcript_path && existsSync(input.transcript_path)) {
      const transcript = parseTranscript(
        readFileSync(input.transcript_path, 'utf8'),
      );
      report.findings.push(...checkTranscriptOrdering(transcript).findings);
    }

    if (!hasErrors(report)) process.exit(0);
    process.stderr.write(`${renderReport(report)}\n`);
    process.exit(2);
  } catch {
    process.exit(0);
  }
}

// Both sides go through `realpathSync` before comparing, matching the pattern the other
// payload scripts use. `process.argv[1]` stays the literal invocation path while
// `import.meta.url` resolves through any symlink in its ancestry, so raw string comparison
// misses on any repo staged under a symlinked temp dir. Guarding this way is also what lets
// a test import the checks without the module exiting the process on load.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
