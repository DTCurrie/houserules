#!/usr/bin/env node
/**
 * Non-interactive changeset author. Validates package names and bump levels, then writes
 * the changeset with the repo's own @changesets/write, the exact writer `changeset add`
 * uses, so files always match the installed changesets version. That library is required.
 * When it cannot be resolved from the repo root this exits 1 with install instructions.
 *
 * Usage:
 *   changeset-write.mjs --pkg <name>[:patch|minor|major] [--pkg ...] --summary "..."
 *   changeset-write.mjs --empty --summary "why no release is needed"
 *   changeset-write.mjs --amend <id> --summary "..." [--pkg ...]
 *   changeset-write.mjs --amend <keep> --absorb <id> [--absorb ...] --summary "..."
 *   echo "summary" | changeset-write.mjs --pkg <name>
 *
 * Options:
 *   --pkg name[:level]  package to bump. Repeatable. Level defaults to --level.
 *   --level <l>         default bump level for --pkg entries without one (patch).
 *   --summary "..."     changelog body. Read from stdin when omitted and piped.
 *   --empty             record "no release needed" (no packages bumped).
 *   --amend <id>        rewrite a pending .changeset/<id>.md in place instead of adding
 *                       a new one, for a feature that already has a changeset. Its
 *                       declared bumps are kept and merged with any --pkg given.
 *   --absorb <id>       fold another pending changeset into --amend and delete it.
 *                       Repeatable. Requires --amend. The survivor's bumps are the
 *                       union of its own, every absorbed file's, and any --pkg given,
 *                       at the highest level named for each package.
 *
 * Package names are validated against the packages that actually exist, the workspace
 * members or the root package in a single-package repo, never against a possibly-stale
 * kit.config.json.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { listPublishablePackageNames } from '@agent-kit/payload/workspaces';

const LEVELS = new Set(['patch', 'minor', 'major']);
const LEVEL_RANK: Record<string, number> = { patch: 0, minor: 1, major: 2 };
const RELEASE_LINE = /^\s*['"]?([^'"]+?)['"]?\s*:\s*(patch|minor|major)\s*$/;

interface Changeset {
  summary: string;
  releases: { name: string; type: string }[];
}

interface Release {
  name: string;
  level: string;
}

// Shape of the repo's own @changesets/write, resolved dynamically at runtime —
// it is never a dependency of this package (see loadOfficialWrite).
type ChangesetWriter = (changeset: Changeset, cwd: string) => Promise<string>;

// Falls back to @changesets/cli's own module context, because a strict layout like
// pnpm's does not expose transitive deps at the root.
async function loadOfficialWrite(
  root: string,
): Promise<ChangesetWriter | null> {
  const req = createRequire(join(root, 'package.json'));
  let resolved: string;
  try {
    resolved = req.resolve('@changesets/write');
  } catch {
    try {
      resolved = createRequire(
        req.resolve('@changesets/cli/package.json'),
      ).resolve('@changesets/write');
    } catch {
      return null;
    }
  }
  const mod = (await import(pathToFileURL(resolved).href)) as {
    default?: ChangesetWriter | { default?: ChangesetWriter };
  };
  const write =
    (mod.default as { default?: ChangesetWriter } | undefined)?.default ??
    (mod.default as ChangesetWriter | undefined);
  if (typeof write !== 'function')
    throw new Error(`@changesets/write at ${resolved} has no write function.`);
  return write;
}

function usage(message?: string): never {
  if (message) console.error(`${message}\n`);
  console.error(
    [
      'Usage:',
      '  changeset-write.mjs --pkg <name>[:patch|minor|major] [--pkg ...] --summary "..."',
      '  changeset-write.mjs --empty --summary "why no release is needed"',
      '  changeset-write.mjs --amend <id> --summary "..." [--pkg ...]',
      '  changeset-write.mjs --amend <keep> --absorb <id> [--absorb ...] --summary "..."',
      '',
      'Summary comes from --summary or stdin. Multiple --pkg flags allowed.',
    ].join('\n'),
  );
  process.exit(1);
}

// Accepts the id, the filename, or the path the script itself printed, so amending never
// needs the caller to reshape what they were handed.
function resolveAmendTarget(changesetDir: string, raw: string): string {
  const name = basename(raw).replace(/\.md$/i, '');
  if (!name || /^readme$/i.test(name)) {
    console.error(`"${raw}" is not a changeset id.`);
    process.exit(1);
  }
  const file = join(changesetDir, `${name}.md`);
  if (!existsSync(file)) {
    console.error(`No pending changeset at .changeset/${name}.md.`);
    process.exit(1);
  }
  return file;
}

// The frontmatter @changesets/write emits is one `'name': level` per line between two
// `---` fences, so a line scan reads it back without a parser dependency.
function readReleases(file: string): Release[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines[0]?.trim() !== '---') return [];
  const releases: Release[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const match = RELEASE_LINE.exec(line);
    if (match) releases.push({ name: match[1], level: match[2] });
  }
  return releases;
}

// An amended changeset covers the whole feature, so a package the pending file already
// declares stays declared. On a conflict the higher bump wins, since the feature grew
// into it.
function mergeReleases(existing: Release[], incoming: Release[]): Release[] {
  const byName = new Map(existing.map((r) => [r.name, r]));
  for (const entry of incoming) {
    const prior = byName.get(entry.name);
    if (!prior || LEVEL_RANK[entry.level] > LEVEL_RANK[prior.level])
      byName.set(entry.name, entry);
  }
  return [...byName.values()];
}

let values: {
  pkg?: string[];
  summary?: string;
  level?: string;
  empty?: boolean;
  amend?: string;
  absorb?: string[];
};
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pkg: { type: 'string', multiple: true },
      summary: { type: 'string' },
      level: { type: 'string' },
      empty: { type: 'boolean' },
      amend: { type: 'string' },
      absorb: { type: 'string', multiple: true },
    },
    allowPositionals: false,
  }));
} catch (e) {
  const message = (e as Error).message;
  const bad = message.match(/'(-[^']*)'/)?.[1] ?? message;
  usage(`Unknown argument "${bad}".`);
}

const pkgArgs = values.pkg ?? [];
const summaryArg = values.summary;
const defaultLevel = values.level ?? 'patch';
const empty = values.empty ?? false;
if (!LEVELS.has(defaultLevel))
  usage(`Invalid --level "${defaultLevel}" (patch|minor|major).`);

let root: string;
try {
  root = execSync('git rev-parse --show-toplevel', {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
} catch {
  console.error('Not inside a git work tree.');
  process.exit(1);
}

let summary = summaryArg;
if (summary === undefined && !process.stdin.isTTY) {
  try {
    summary = readFileSync(0, 'utf8');
  } catch {
    summary = '';
  }
}
summary = (summary ?? '').trim();
if (!summary)
  usage(
    'A non-empty --summary (or piped stdin) is required — it becomes the changelog entry.',
  );

const dir = join(root, '.changeset');
mkdirSync(dir, { recursive: true });
if (!existsSync(join(dir, 'config.json'))) {
  console.error(
    'note: .changeset/config.json is missing — run `npx @changesets/cli init` before release time.',
  );
}

const amendTarget = values.amend
  ? resolveAmendTarget(dir, values.amend)
  : undefined;

const absorbArgs = values.absorb ?? [];
if (absorbArgs.length && !amendTarget)
  usage('--absorb requires --amend <id> to name the changeset that survives.');
if (absorbArgs.length && empty)
  usage(
    '--empty cannot be combined with --absorb. The absorbed bumps would be discarded.',
  );

const absorbTargets: string[] = [];
for (const raw of absorbArgs) {
  const file = resolveAmendTarget(dir, raw);
  if (file === amendTarget) {
    console.error(`Cannot absorb "${raw}" into itself.`);
    process.exit(1);
  }
  absorbTargets.push(file);
}

let entries: Release[] = [];
if (!empty) {
  const valid = listPublishablePackageNames(root);
  if (!valid.length) {
    console.error(
      'No packages found (no workspace members and no named root package.json).',
    );
    process.exit(1);
  }
  entries = pkgArgs.map((raw) => {
    if (!raw) usage('--pkg needs a value.');
    const at = raw.lastIndexOf(':');
    const hasLevel = at > 0 && LEVELS.has(raw.slice(at + 1));
    const name = hasLevel ? raw.slice(0, at) : raw;
    const level = hasLevel ? raw.slice(at + 1) : defaultLevel;
    return { name, level };
  });
  if (amendTarget) {
    let merged = readReleases(amendTarget);
    for (const file of absorbTargets)
      merged = mergeReleases(merged, readReleases(file));
    entries = mergeReleases(merged, entries);
  }
  if (!entries.length) {
    if (amendTarget) {
      if (!absorbTargets.length)
        usage(
          'The amended changeset declares no packages. Pass --pkg, or --empty to keep it release-free.',
        );
    } else if (valid.length === 1)
      entries = [{ name: valid[0], level: defaultLevel }];
    else usage(`Specify --pkg. Valid packages: ${valid.join(', ')}`);
  }
  for (const entry of entries) {
    if (!valid.includes(entry.name)) {
      console.error(
        `Unknown package "${entry.name}". Valid packages: ${valid.join(', ')}`,
      );
      process.exit(1);
    }
  }
}

const officialWrite = await loadOfficialWrite(root);
if (!officialWrite) {
  console.error(
    [
      'Cannot author a changeset: @changesets/write is not resolvable from this repo.',
      'agent-kit writes changesets only with the official changesets library — no fallback.',
      'Fix: install the CLI as a root devDependency, then rerun:',
      '  pnpm add -D -w @changesets/cli   # npm: npm install -D @changesets/cli',
      'Notes: a pnpx/npx-only root script is not enough (nothing is resolvable from',
      'the repo root); pnpm catalogMode strict needs a catalog entry for it first.',
    ].join('\n'),
  );
  process.exit(1);
}

let id: string;
try {
  id = await officialWrite(
    {
      summary,
      releases: entries.map((e) => ({ name: e.name, type: e.level })),
    },
    root,
  );
} catch (e) {
  console.error(`@changesets/write failed: ${(e as Error)?.message ?? e}`);
  process.exit(1);
}

// The official writer always mints its own human-id filename. Amending moves that output
// onto the pending file, so the feature keeps one changeset at one stable path and the
// rewrite reads as a modification rather than an add plus a delete.
if (amendTarget) {
  renameSync(join(dir, `${id}.md`), amendTarget);
  for (const file of absorbTargets) unlinkSync(file);
  console.log(`.changeset/${basename(amendTarget)}`);
} else {
  console.log(`.changeset/${id}.md`);
}
