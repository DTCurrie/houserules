#!/usr/bin/env node
// Non-interactive changeset author (claude-kit). Writes .changeset/kit-<hex>.md
// with validated package names + bump levels. Zero dependencies — a changeset is
// just YAML-frontmatter markdown, so nothing here needs @changesets/cli (only
// release-time `changeset version/publish` does).
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

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

import { listPublishablePackageNames } from './lib/workspaces.mjs';

const LEVELS = new Set(['patch', 'minor', 'major']);

function usage(message) {
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

const argv = process.argv.slice(2);
const pkgArgs = [];
let summaryArg;
let defaultLevel = 'patch';
let empty = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--pkg') pkgArgs.push(argv[++i]);
  else if (a === '--summary') summaryArg = argv[++i];
  else if (a === '--level') defaultLevel = argv[++i];
  else if (a === '--empty') empty = true;
  else usage(`Unknown argument "${a}".`);
}
if (!LEVELS.has(defaultLevel)) usage(`Invalid --level "${defaultLevel}" (patch|minor|major).`);

let root;
try {
  root = execSync('git rev-parse --show-toplevel', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
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
if (!summary) usage('A non-empty --summary (or piped stdin) is required — it becomes the changelog entry.');

let entries = [];
if (!empty) {
  const valid = listPublishablePackageNames(root);
  if (!valid.length) {
    console.error('No packages found (no workspace members and no named root package.json).');
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
      console.error(`Unknown package "${entry.name}". Valid packages: ${valid.join(', ')}`);
      process.exit(1);
    }
  }
}

const dir = join(root, '.changeset');
mkdirSync(dir, { recursive: true });
if (!existsSync(join(dir, 'config.json'))) {
  console.error('note: .changeset/config.json is missing — run `npx @changesets/cli init` before release time.');
}

let file;
do {
  file = join(dir, `kit-${randomBytes(4).toString('hex').slice(0, 6)}.md`);
} while (existsSync(file));

const frontmatter = entries.map((e) => `"${e.name}": ${e.level}`).join('\n');
writeFileSync(file, `---\n${frontmatter ? `${frontmatter}\n` : ''}---\n\n${summary}\n`);
console.log(file.slice(root.length + 1));
