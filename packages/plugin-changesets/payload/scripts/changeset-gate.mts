#!/usr/bin/env node
/**
 * Stop hook. A structural gate over the changesets houserules itself writes.
 *
 * h5 flags a newly-written pending changeset whose declared package set has drifted from
 * what the current diff actually touches ("the package set grew").
 *
 * Exit 2 with the report on stderr when the gate is violated. Every failure path exits 0,
 * because a nudge hook must never break a session. A turn whose transcript shows only
 * read-only tool uses exits 0 before any git call, and a missing or unreadable transcript
 * runs the gate as usual. While the Stop payload's background_tasks is non-empty, h5 is
 * skipped, since background agents are still changing the diff it compares against.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfigSafe } from '@houserules/payload/config';
import { listWorkspacePackages } from '@houserules/payload/workspaces';
import { git, readStdinJson, repoRoot } from '@houserules/payload/proc';
import {
  turnStartedAt,
  turnTouchedFiles,
} from '@houserules/payload/transcript-turn';
import {
  emptyReport,
  hasErrors,
  renderReport,
  type Finding,
  type Report,
} from '@houserules/payload/findings';
import { createGatedOwnerResolver } from './lib/changeset-owner.mjs';

const DECLINED = [
  'whether two changesets describe the same feature — feature identity is a reading-comprehension judgment the changeset skill keeps',
  'whether a major/minor/patch level is the RIGHT level for a change — semver judgment stays in the skill',
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
 * Reports a package the diff touches that **no** pending changeset declares. `pending` is the
 * set judged this turn, and `settled` is the branch's other pending changesets, which count
 * toward coverage but are never reported on.
 *
 * The union matters. Comparing each changeset against the whole diff individually treats every
 * sibling changeset as drift, so a repo with one changeset per package reports every one of them
 * as wrong forever. That is what happened the first time this gate ran for real, against 16
 * pending first-release changesets. A settled sibling counts for the same reason: once the gate
 * scoped itself to the turn, a changeset written two turns earlier covered its package and the
 * gate reported it anyway.
 */
export function checkPackageDrift(
  pending: PendingChangeset[],
  touchedPkgs: string[],
  settled: PendingChangeset[],
): Report {
  const report = emptyReport();
  if (pending.length === 0) return report;
  const covered = new Set(
    [...pending, ...settled].flatMap((cs) => cs.declaredPkgs),
  );
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

/** The ids whose changeset file was last written at or after `turnStart`, epoch milliseconds. */
function writtenSinceTurnStart(
  root: string,
  ids: Set<string>,
  turnStart: number,
): Set<string> {
  return new Set(
    [...ids].filter((id) => {
      try {
        return (
          statSync(join(root, '.changeset', `${id}.md`)).mtimeMs >= turnStart
        );
      } catch {
        return true;
      }
    }),
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
  const gatedOwner = createGatedOwnerResolver(
    root,
    pkgs,
    loadConfigSafe(root).changesets?.gateIgnore ?? [],
  );
  const names = new Set<string>();
  for (const path of [...dirty, ...committed]) {
    if (isChangesetMd(path)) continue;
    if (wireitOnlyEdit(root, path, committedSet.has(path) ? mergeBase : 'HEAD'))
      continue;
    const name = gatedOwner(path);
    if (name) names.add(name);
  }
  return [...names];
}

/** h5 over the changesets written this turn, with the branch's earlier ones counted as coverage. */
function packageDriftFindings(
  root: string,
  transcriptPath: string | undefined,
): Finding[] {
  const pendingFiles = readPendingChangesets(root);
  // No changeset file means nothing to judge, so no git call is worth its cost.
  if (pendingFiles.size === 0) return [];
  const branchIds = newChangesetIds(root);
  const turnStart = turnStartedAt(transcriptPath);
  // A changeset last written before the prompt belongs to an earlier turn.
  const newIds =
    turnStart === undefined
      ? branchIds
      : writtenSinceTurnStart(root, branchIds, turnStart);
  const toPending = (id: string): PendingChangeset => ({
    id,
    declaredPkgs: parseDeclaredPackages(pendingFiles.get(id)!),
  });
  const pending = [...newIds]
    .filter((id) => pendingFiles.has(id))
    .map(toPending);
  // This branch's own changesets from earlier turns. One already on main belongs to another
  // feature and never covers this diff.
  const settled = [...branchIds]
    .filter((id) => !newIds.has(id) && pendingFiles.has(id))
    .map(toPending);
  return checkPackageDrift(
    pending,
    pending.length > 0 ? touchedPackages(root) : [],
    settled,
  ).findings;
}

async function main(): Promise<void> {
  const input = readStdinJson<{
    stop_hook_active?: boolean;
    transcript_path?: string;
    background_tasks?: unknown[];
  }>();
  if (input.stop_hook_active) process.exit(0);
  if (turnTouchedFiles(input.transcript_path) === false) process.exit(0);

  try {
    const root = repoRoot();
    const report = emptyReport();
    report.declined.push(...DECLINED);

    // h5 reads the diff, which background agents are still changing.
    const isTreeMoving =
      Array.isArray(input.background_tasks) &&
      input.background_tasks.length > 0;
    if (!isTreeMoving)
      report.findings.push(
        ...packageDriftFindings(root, input.transcript_path),
      );

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
  await main();
}
