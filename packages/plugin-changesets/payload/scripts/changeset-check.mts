#!/usr/bin/env node
/**
 * Stop hook. Nudges when package source changed with no changeset alongside it.
 *
 * Exit 2 with stderr asks Claude to write the changeset, or to record --empty saying why
 * not. Exit 0 stays silent, and every failure path exits 0, because a nudge hook must
 * never break a session.
 *
 * Config (houserules.config.json): changesets.enabled must be true, changesets.stopCheck
 * (default true) is the kill-switch, changesets.baseBranch (default "main") is the
 * comparison base. Source scope is targets[].sourcePath, else workspace packages.
 */

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';

import { loadConfigSafe, repoRootSafe } from '@houserules/payload/config';
import { listWorkspacePackages } from '@houserules/payload/workspaces';
import { git, readStdinJson } from '@houserules/payload/proc';

const STATE_DIR = '.claude/state';
const STATE_FILE = 'changeset-check.json';
const MAX_LISTED_PENDING = 5;

function signatureOf(paths: string[]): string {
  return createHash('sha256')
    .update([...paths].sort().join('\n'))
    .digest('hex');
}

// Best-effort: any failure (missing or corrupt file) means no prior record. This falls
// open to nudging, never to suppressing. A missing file is the ordinary first-run case
// and stays silent. Anything else (corrupt JSON, a permission error) is unexpected, so
// it gets a stderr line naming the failure. The fail-open behavior does not change, but
// a reader watching stderr can now tell "nothing recorded yet" apart from "could not
// read what was recorded."
function readLastSignature(root: string): string | undefined {
  const statePath = join(root, STATE_DIR, STATE_FILE);
  if (!existsSync(statePath)) return undefined;
  try {
    const raw = readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as { signature?: unknown };
    return typeof parsed.signature === 'string' ? parsed.signature : undefined;
  } catch (err) {
    console.error(
      `changeset-check: could not read ${STATE_FILE}, treating as no prior record: ${(err as Error).message}`,
    );
    return undefined;
  }
}

// A write failure must never change the exit code. The nudge already happened this turn,
// and an unrecorded one just nudges again next turn, which fails open.
function writeLastSignature(root: string, signature: string): void {
  try {
    const dir = join(root, STATE_DIR);
    mkdirSync(dir, { recursive: true });
    const gitignore = join(dir, '.gitignore');
    if (!existsSync(gitignore)) {
      writeFileSync(gitignore, '*\n!.gitignore\n');
    }
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ signature }) + '\n');
  } catch {
    // Unwritable state dir/file: silently skip persistence, never crash the hook.
  }
}

interface HookInput {
  stop_hook_active?: boolean;
}

const input = readStdinJson<HookInput>();
if (input.stop_hook_active) process.exit(0);

const isChangesetMd = (p: string): boolean =>
  p.startsWith('.changeset/') && p.endsWith('.md') && !/\/readme\.md$/i.test(p);

// Every changeset awaiting release, whether committed or not. The nudge fires when THIS
// change has none of its own, which on the base branch includes a feature whose changeset
// landed in an earlier commit. Naming them steers the next changeset into an --amend
// instead of a second file for one feature.
function listPendingChangesets(root: string): string[] {
  const dir = join(root, '.changeset');
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !/^readme\.md$/i.test(f))
      .sort();
  } catch (err) {
    // ENOENT is the ordinary "no .changeset/ dir yet" case, indistinguishable in effect
    // from a genuinely empty one, so it stays silent. Anything else (permissions, a path
    // collision) is unexpected and gets a stderr line, so it does not read the same as an
    // empty pending list.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(
        `changeset-check: could not list ${dir}: ${(err as Error).message}`,
      );
    }
    return [];
  }
}

// Generated files are churn, not package source. A root-package target scopes every
// top-level non-dotfile, so without this they would trip the nudge on their own.
//
// Read from `generatedFilePattern` rather than hardcoded, so this and lint-format-fix.mjs
// answer "is this file generated" from one place a repo can configure. The rendered ledgers
// no longer reach here at all, since they live in the ledger directory and are gitignored,
// but CHANGELOG.md is still both generated and tracked.
const generatedFileRe = (pattern?: string): RegExp =>
  new RegExp(pattern ?? '/(?:CHANGELOG|BACKLOG)\\.md$');

try {
  // Resolved before the config load so the root is passed in rather than spawned twice.
  const root = repoRootSafe();
  if (!root) process.exit(0);

  const config = loadConfigSafe(root);
  const cs = config.changesets ?? {};
  if (cs.enabled !== true || cs.stopCheck === false) process.exit(0);

  let scopes: string[] = (config.targets ?? [])
    .map((t) => t.sourcePath)
    .filter((s): s is string => s !== undefined && s !== null);
  if (!scopes.length) scopes = listWorkspacePackages(root).map((p) => p.relDir);
  if (!scopes.length) process.exit(0);
  const matchScope = (p: string): boolean =>
    scopes.some((s) =>
      s === '' ? !p.startsWith('.') : p === s || p.startsWith(`${s}/`),
    );

  // Working tree: every dirty path counts, whatever its status code.
  const status = git(root, ['status', '--porcelain']) ?? '';
  const dirty = status
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''));

  // One name-status call covers both consumers: every changed path, and the ADDED
  // ones under .changeset/.
  const base = cs.baseBranch ?? 'main';
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
  let committed: string[] = [];
  let committedNewChangesets: string[] = [];
  if (
    branch &&
    branch !== base &&
    git(root, ['rev-parse', '--verify', '--quiet', base]) !== null
  ) {
    const nameStatus = (
      git(root, ['diff', '--name-status', `${base}...HEAD`]) ?? ''
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const fields = line.split('\t');
        return { status: fields[0], path: fields[fields.length - 1] };
      })
      .filter(
        (e): e is { status: string; path: string } =>
          e.status !== undefined && e.path !== undefined,
      );
    committed = nameStatus.map((e) => e.path);
    committedNewChangesets = nameStatus
      .filter(
        (e) => e.status.startsWith('A') && e.path.startsWith('.changeset/'),
      )
      .map((e) => e.path);
  }

  const isGenerated = generatedFileRe(config.generatedFilePattern);
  const srcChanged = [...dirty, ...committed].filter(
    (p) => matchScope(p) && !isGenerated.test(`/${p}`),
  );
  const hasChangeset =
    dirty.some(isChangesetMd) || committedNewChangesets.some(isChangesetMd);

  if (!srcChanged.length || hasChangeset) process.exit(0);

  const signature = signatureOf(srcChanged);
  if (readLastSignature(root) === signature) process.exit(0);

  const targets = (config.targets ?? []).filter((t) =>
    srcChanged.some((p) =>
      t.sourcePath === ''
        ? true
        : p === t.sourcePath || p.startsWith(`${t.sourcePath}/`),
    ),
  );
  const names = targets.map((t) => t.packageName).filter((n) => n && n !== '.');
  const pkgHint = names.length
    ? names.map((n) => `--pkg ${n}`).join(' ')
    : '--pkg <package-name>';

  const pending = listPendingChangesets(root);
  const amendHint = pending.length
    ? [
        `${pending.length} changeset(s) already pending: ${pending.slice(0, MAX_LISTED_PENDING).join(', ')}${pending.length > MAX_LISTED_PENDING ? ', …' : ''}`,
        'One changeset per feature. If this continues a feature one of them describes, amend that one:',
        '  node .claude/scripts/changeset-write.mjs --amend <id> --summary "<summary for the whole feature>"',
        'If it is a separate user-visible change, add one:',
      ]
    : ['If the change is user-visible, add one now:'];

  process.stderr.write(
    [
      `Package source changed (${srcChanged.length} file(s)) with no changeset recorded.`,
      ...amendHint,
      `  node .claude/scripts/changeset-write.mjs ${pkgHint} --summary "<what changed and why>"`,
      'If no release is warranted (tests, tooling, docs), record that instead:',
      '  node .claude/scripts/changeset-write.mjs --empty --summary "<why no release>"',
    ].join('\n') + '\n',
  );
  writeLastSignature(root, signature);
  process.exit(2);
} catch {
  process.exit(0);
}
