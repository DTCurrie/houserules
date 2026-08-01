#!/usr/bin/env node
// Non-interactive changeset author (claude-kit). Validates package names + bump
// levels, then writes the changeset with the repo's own @changesets/write — the
// exact writer `changeset add` uses, so files always match the installed
// changesets version. The official library is REQUIRED: when it can't be
// resolved from the repo root, exit 1 with install instructions. This script
// never hand-rolls changeset files — authoring belongs to changesets itself;
// the kit only adds workspace validation and a non-interactive interface.
//
// Usage:
//   changeset-write.mjs --pkg <name>[:patch|minor|major] [--pkg ...] --summary "..."
//   changeset-write.mjs --empty --summary "why no release is needed"
//   echo "summary" | changeset-write.mjs --pkg <name>
//
// Options:
//   --pkg name[:level]  package to bump; repeatable. Level defaults to --level.
//   --level <l>         default bump level for --pkg entries without one (patch).
//   --summary "..."     changelog body; read from stdin when omitted and piped.
//   --empty             record "no release needed" (no packages bumped).
//
// Package names are validated against the packages that ACTUALLY exist (workspace
// members, or the root package in a single-package repo) — never against a
// possibly-stale kit.config.json.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { listPublishablePackageNames } from './lib/workspaces.mjs';

const LEVELS = new Set(['patch', 'minor', 'major']);

interface Changeset {
  summary: string;
  releases: { name: string; type: string }[];
}

// Shape of the repo's own @changesets/write, resolved dynamically at runtime —
// it is never a dependency of this package (see loadOfficialWrite).
type ChangesetWriter = (changeset: Changeset, cwd: string) => Promise<string>;

// The repo's installed @changesets/write, or null when changesets isn't
// installed. Resolved from the repo root, then through @changesets/cli's own
// module context — package managers with a strict layout (pnpm) don't expose
// transitive deps at the root. Import/shape failures of a RESOLVED module are
// not caught: that's a broken install worth a loud stack, not a missing one.
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
      '',
      'Summary comes from --summary or stdin. Multiple --pkg flags allowed.',
    ].join('\n'),
  );
  process.exit(1);
}

let values: {
  pkg?: string[];
  summary?: string;
  level?: string;
  empty?: boolean;
};
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pkg: { type: 'string', multiple: true },
      summary: { type: 'string' },
      level: { type: 'string' },
      empty: { type: 'boolean' },
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

let entries: { name: string; level: string }[] = [];
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
  if (!entries.length) {
    if (valid.length === 1) entries = [{ name: valid[0], level: defaultLevel }];
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

const dir = join(root, '.changeset');
mkdirSync(dir, { recursive: true });
if (!existsSync(join(dir, 'config.json'))) {
  console.error(
    'note: .changeset/config.json is missing — run `npx @changesets/cli init` before release time.',
  );
}

const officialWrite = await loadOfficialWrite(root);
if (!officialWrite) {
  console.error(
    [
      'Cannot author a changeset: @changesets/write is not resolvable from this repo.',
      'claude-kit writes changesets only with the official changesets library — no fallback.',
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
console.log(`.changeset/${id}.md`);
