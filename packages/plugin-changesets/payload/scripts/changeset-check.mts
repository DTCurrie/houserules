#!/usr/bin/env node
/**
 * Stop hook. Nudges when package source changed with no changeset alongside it.
 *
 * Exit 2 with stderr asks Claude to write the changeset, or to record --empty saying why
 * not. Exit 0 stays silent, and every failure path exits 0, because a nudge hook must
 * never break a session.
 *
 * Config (kit.config.json): changesets.enabled must be true, changesets.stopCheck
 * (default true) is the kill-switch, changesets.baseBranch (default "main") is the
 * comparison base. Source scope is targets[].sourcePath, else workspace packages.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfigSafe } from './lib/kit-config.mjs';
import { listWorkspacePackages } from './lib/workspaces.mjs';
import { git, readStdinJson } from './lib/proc.mjs';

const STATE_DIR = '.claude/state';
const STATE_FILE = 'changeset-check.json';

function signatureOf(paths: string[]): string {
  return createHash('sha256')
    .update([...paths].sort().join('\n'))
    .digest('hex');
}

// Best-effort: any failure (missing/corrupt file) means "no prior record", which
// falls open to nudging — never to suppressing.
function readLastSignature(root: string): string | undefined {
  try {
    const raw = readFileSync(join(root, STATE_DIR, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as { signature?: unknown };
    return typeof parsed.signature === 'string' ? parsed.signature : undefined;
  } catch {
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
  const config = loadConfigSafe();
  const cs = config.changesets ?? {};
  if (cs.enabled !== true || cs.stopCheck === false) process.exit(0);

  const rootOut = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!rootOut) process.exit(0);
  const root = rootOut.trim();

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
      });
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

  process.stderr.write(
    [
      `Package source changed (${srcChanged.length} file(s)) with no changeset recorded.`,
      'If the change is user-visible, add one now:',
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
