#!/usr/bin/env node
// Stop hook (claude-kit): nudge when package source changed with no changeset
// alongside it. Changesets accompany the change, not the release — this converts
// that convention into a deterministic check.
//
// Exit 2 (+stderr) asks Claude to write the changeset (or record --empty why not);
// exit 0 stays silent. EVERY failure path exits 0: a nudge hook must never break
// a session. Branch-aware: a changeset already committed on this branch counts,
// so the nudge can't recur turn after turn.
//
// Config (kit.config.json): changesets.enabled must be true, changesets.stopCheck
// (default true) is the kill-switch, changesets.baseBranch (default "main") is the
// comparison base. Source scope = targets[].sourcePath, else workspace packages.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { loadConfigSafe } from './lib/kit-config.mjs';
import { listWorkspacePackages } from './lib/workspaces.mjs';

interface HookInput {
  stop_hook_active?: boolean;
}

let input: HookInput = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  /* no payload — fine */
}
if (input.stop_hook_active) process.exit(0);

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

const isChangesetMd = (p: string): boolean =>
  p.startsWith('.changeset/') && p.endsWith('.md') && !/\/readme\.md$/i.test(p);

// Generated ledgers are churn, not package source: the kit generates CHANGELOG.md
// from changesets and BACKLOG.md via the backlog helper. Editing them never warrants
// a changeset (see CLAUDE.md "don't chase BACKLOG.md/CHANGELOG.md churn"), yet a
// root-package target (sourcePath "") scopes every top-level non-dotfile, so without
// this they would trip the nudge on their own.
const isGeneratedLedger = (p: string): boolean => {
  const base = p.split('/').pop();
  return base === 'BACKLOG.md' || base === 'CHANGELOG.md';
};

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

  // Branch: everything since the changesets base, when it resolves.
  const base = cs.baseBranch ?? 'main';
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
  let committed: string[] = [];
  let committedNewChangesets: string[] = [];
  if (
    branch &&
    branch !== base &&
    git(root, ['rev-parse', '--verify', '--quiet', base]) !== null
  ) {
    committed = (git(root, ['diff', '--name-only', `${base}...HEAD`]) ?? '')
      .split('\n')
      .filter(Boolean);
    committedNewChangesets = (
      git(root, [
        'diff',
        '--name-only',
        '--diff-filter=A',
        `${base}...HEAD`,
        '--',
        '.changeset',
      ]) ?? ''
    )
      .split('\n')
      .filter(Boolean);
  }

  const srcChanged = [...dirty, ...committed].filter(
    (p) => matchScope(p) && !isGeneratedLedger(p),
  );
  const hasChangeset =
    dirty.some(isChangesetMd) || committedNewChangesets.some(isChangesetMd);

  if (!srcChanged.length || hasChangeset) process.exit(0);

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
  process.exit(2);
} catch {
  process.exit(0);
}
