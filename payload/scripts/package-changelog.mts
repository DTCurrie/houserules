#!/usr/bin/env node
// Package changelog helper (claude-kit). Config-driven via .claude/kit.config.json.
//
// Records committed changes to a tracked source tree so you keep a queryable history
// of what shipped and why. Driven by an archivist agent (or a git hook): the LLM/author
// supplies the bullet summary; this script does all the git plumbing deterministically.
//
// Usage:
//   record <target> <sha|HEAD> --changes "- bullet\n- bullet" [--reason "..."] [--backlog ID[,ID]] [--quiet]
//   show   <target> <short-or-full-sha>
//   list   <target>
//
// Targets are defined in .claude/kit.config.json (the `targets` array; `name` is the key).
//
// Storage (per target):
//   <changelogPath>            — human-readable index (subject, file count, backlog, reason, changes)
//   <logPath>                  — append-only JSONL; same metadata plus the full file list.
//                                Diffs/prior file content are NOT stored — recover via
//                                `git show <sha>` or `git show <sha>~1:<file>`.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { loadConfig, repoRoot } from './lib/kit-config.mjs';
import { BACKLOG_ID } from './lib/backlog-id.mjs';

const REPO_ROOT = repoRoot();
const SEPARATOR = '---';

interface Target {
  name: string;
  sourcePath: string;
  changelogPath: string;
  logPath: string;
  label: string;
}

interface ResolvedTarget extends Target {
  changelogFile: string;
  logFile: string;
}

const config = loadConfig(REPO_ROOT);
const TARGETS: Record<string, Target> = {};
for (const t of config.targets) {
  if (!t.sourcePath) continue;
  // Default paths live under .claude/changelogs/ so this ledger can NEVER collide
  // with the CHANGELOG.md that `changeset version` owns.
  TARGETS[t.name] = {
    name: t.name,
    sourcePath: t.sourcePath,
    changelogPath: t.changelogPath ?? `.claude/changelogs/${t.name}.md`,
    logPath: t.logPath ?? `.claude/changelogs/${t.name}.log`,
    label: t.label ?? t.name,
  };
}

const nowIso = () => new Date().toISOString();

function shStr(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' });
}
function tryShStr(cmd: string): string | null {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function getTarget(name: string): ResolvedTarget {
  const t = TARGETS[name];
  if (!t) {
    console.error(
      `Unknown target "${name}". Valid: ${Object.keys(TARGETS).join(', ') || '(none — check .claude/kit.config.json)'}.`,
    );
    process.exit(1);
  }
  return {
    ...t,
    changelogFile: resolve(REPO_ROOT, t.changelogPath),
    logFile: resolve(REPO_ROOT, t.logPath),
  };
}

function resolveSha(ref: string): string {
  const out = tryShStr(`git rev-parse --verify ${ref}^{commit}`);
  if (!out) {
    console.error(`Could not resolve commit "${ref}".`);
    process.exit(1);
  }
  return out.trim();
}

interface CommitInfo {
  fullSha: string;
  shortSha: string;
  date: string;
  subject: string;
  body: string;
}

function gatherCommitInfo(fullSha: string): CommitInfo {
  const fmt = '%H%x1f%aI%x1f%s%x1f%b';
  const raw = shStr(`git show -s --format=${fmt} ${fullSha}`);
  const trimmed = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const [sha, isoDate, subject, body = ''] = trimmed.split('\x1f');
  return {
    fullSha: sha,
    shortSha: sha.slice(0, 7),
    date: isoDate.slice(0, 10),
    subject,
    body: body.replace(/\s+$/, ''),
  };
}

function listChangedFiles(fullSha: string, sourcePath: string): string[] {
  const out =
    tryShStr(`git show --name-only --pretty= ${fullSha} -- ${sourcePath}`) ||
    '';
  return out.split('\n').filter((f) => f && f.startsWith(sourcePath));
}

function extractBacklogIds(...sources: (string | undefined)[]): string[] {
  const ids = new Set<string>();
  for (const text of sources) {
    if (!text) continue;
    for (const m of text.match(BACKLOG_ID) || []) ids.add(m);
  }
  return [...ids];
}

function ensureChangelogHeader(target: ResolvedTarget) {
  if (existsSync(target.changelogFile)) return;
  mkdirSync(dirname(target.changelogFile), { recursive: true });
  writeFileSync(
    target.changelogFile,
    [
      `# ${target.label} Changelog`,
      '',
      `Per-commit record of changes to \`${target.sourcePath}/\`. Maintained by`,
      '`.claude/scripts/package-changelog.mjs` and the corresponding archivist agent.',
      '',
      'Each entry summarises what shipped as a bullet list. For the full diff or',
      'any prior file state, use git directly:',
      '',
      '```',
      'git show <sha>',
      'git show <sha>~1:<file>',
      '```',
      '',
      `The companion log \`${target.logPath}\` mirrors these entries as JSONL`,
      `for queries (\`node .claude/scripts/package-changelog.mjs list ${target.name}\`).`,
      '',
      SEPARATOR,
      '',
      '',
    ].join('\n'),
  );
}

function entryExistsInChangelog(
  target: ResolvedTarget,
  shortSha: string,
): boolean {
  if (!existsSync(target.changelogFile)) return false;
  const text = readFileSync(target.changelogFile, 'utf8');
  return new RegExp(`^## \\[${shortSha}\\] `, 'm').test(text);
}

interface ChangelogEntryInput {
  shortSha: string;
  date: string;
  subject: string;
  files: string[];
  backlog: string[];
  reason: string;
  changes: string;
}

function renderChangelogEntry({
  shortSha,
  date,
  subject,
  files,
  backlog,
  reason,
  changes,
}: ChangelogEntryInput): string {
  const filesLine =
    files.length <= 6
      ? files.map((f) => `\`${f}\``).join(', ')
      : `${files.length} files`;
  const backlogLine = backlog.length ? backlog.join(', ') : '_none_';
  const reasonBlock = reason.trim() ? reason.trim() : '_no reason recorded_';
  const changesBlock = changes.trim() || '_(no changes recorded)_';
  return [
    `## [${shortSha}] ${subject}`,
    '',
    `**Date:** ${date} · **Files:** ${filesLine} · **Backlog:** ${backlogLine}`,
    '',
    reasonBlock,
    '',
    '### Changes',
    '',
    changesBlock,
    '',
    SEPARATOR,
    '',
    '',
  ].join('\n');
}

function appendToChangelog(target: ResolvedTarget, entry: string) {
  ensureChangelogHeader(target);
  const padded = readFileSync(target.changelogFile, 'utf8').replace(
    /\s*$/,
    '\n\n',
  );
  writeFileSync(target.changelogFile, padded + entry);
}

function appendEvent(target: ResolvedTarget, record: Record<string, unknown>) {
  mkdirSync(dirname(target.logFile), { recursive: true });
  appendFileSync(target.logFile, JSON.stringify(record) + '\n');
}

interface RecordCommitOptions {
  reason?: string;
  backlog?: string;
  changes?: string;
  quiet?: boolean;
}

function recordCommit(
  target: ResolvedTarget,
  ref: string,
  {
    reason: reasonOverride,
    backlog: backlogOverride,
    changes: changesInput,
    quiet,
  }: RecordCommitOptions = {},
) {
  const fullSha = resolveSha(ref);
  const info = gatherCommitInfo(fullSha);
  const files = listChangedFiles(fullSha, target.sourcePath);
  if (!files.length) {
    if (!quiet)
      console.error(
        `Commit ${info.shortSha} does not touch ${target.sourcePath}/. Nothing recorded.`,
      );
    return { skipped: true, reason: 'no-target-files' };
  }
  if (entryExistsInChangelog(target, info.shortSha)) {
    if (!quiet)
      console.error(
        `Entry for ${info.shortSha} already in ${target.changelogPath}. Skipping.`,
      );
    return { skipped: true, reason: 'duplicate' };
  }
  if (!changesInput || !changesInput.trim()) {
    console.error(
      'Missing required --changes "<bullet list>". The archivist agent must summarise what shipped.',
    );
    process.exit(1);
  }

  const reason = (reasonOverride ?? info.body ?? '').trim();
  const changes = changesInput.trim();

  let backlog;
  if (backlogOverride !== undefined) {
    backlog = backlogOverride
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    backlog = extractBacklogIds(info.subject, info.body, reason);
  }

  appendToChangelog(
    target,
    renderChangelogEntry({
      shortSha: info.shortSha,
      date: info.date,
      subject: info.subject,
      files,
      backlog,
      reason,
      changes,
    }),
  );

  appendEvent(target, {
    ts: nowIso(),
    action: 'record',
    sha: info.shortSha,
    fullSha: info.fullSha,
    date: info.date,
    subject: info.subject,
    body: info.body,
    reason,
    backlog,
    files,
    changes,
  });

  if (!quiet) console.log(info.shortSha);
  return { skipped: false, sha: info.shortSha };
}

interface LogRecord {
  ts: string;
  action: string;
  sha: string;
  fullSha: string;
  date: string;
  subject: string;
  body: string;
  reason: string;
  backlog: string[];
  files: string[];
  changes: string;
}

function show(target: ResolvedTarget, ref: string) {
  if (!existsSync(target.logFile)) {
    console.error(`No ${target.label.toLowerCase()} changelog log yet.`);
    process.exit(1);
  }
  const lines = readFileSync(target.logFile, 'utf8')
    .split('\n')
    .filter(Boolean);
  let found = 0;
  for (const line of lines) {
    let r: LogRecord;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const matches =
      r.sha === ref ||
      r.fullSha === ref ||
      (ref.length >= 7 && r.fullSha.startsWith(ref));
    if (!matches) continue;
    found++;
    console.log(`[${r.ts}] ${r.action} ${r.sha} — ${r.subject}`);
    console.log(`date: ${r.date}`);
    console.log(`files: ${r.files.join(', ')}`);
    console.log(
      `backlog: ${r.backlog.length ? r.backlog.join(', ') : '(none)'}`,
    );
    console.log(`reason: ${r.reason || '(none)'}`);
    console.log('--- changes ---');
    console.log(r.changes || '(none)');
    console.log(SEPARATOR);
  }
  if (!found) {
    console.error(`No log entries for ${ref}.`);
    process.exit(1);
  }
}

function list(target: ResolvedTarget) {
  if (!existsSync(target.logFile)) return;
  const lines = readFileSync(target.logFile, 'utf8')
    .split('\n')
    .filter(Boolean);
  for (const line of lines) {
    let r: LogRecord;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const backlog = r.backlog?.length ? ` [${r.backlog.join(',')}]` : '';
    console.log(`${r.sha}  ${r.date}  ${r.subject}${backlog}`);
  }
}

function usage() {
  console.error(
    [
      'Usage:',
      '  package-changelog.mjs record <target> <sha|HEAD> --changes "<bullets>" [--reason "..."] [--backlog ID[,ID]] [--quiet]',
      '  package-changelog.mjs show   <target> <short-or-full-sha>',
      '  package-changelog.mjs list   <target>',
      '',
      `Targets (from .claude/kit.config.json): ${Object.keys(TARGETS).join(', ') || '(none defined)'}`,
      '',
      '--changes is required and should be a markdown bullet list of what shipped.',
      'Pass via heredoc for multiline:',
      "  ... record <target> HEAD --changes \"$(cat <<'EOF'",
      '  - one thing',
      '  - another thing',
      '  EOF',
      '  )"',
    ].join('\n'),
  );
}

const [, , action, ...rest] = process.argv;
const { values: flags, positionals: positional } = parseArgs({
  args: rest,
  options: {
    changes: { type: 'string' },
    reason: { type: 'string' },
    backlog: { type: 'string' },
    quiet: { type: 'boolean' },
  },
  allowPositionals: true,
  strict: false,
});

switch (action) {
  case 'record': {
    const [name, ref = 'HEAD'] = positional;
    if (!name) {
      usage();
      process.exit(1);
    }
    recordCommit(getTarget(name), ref, flags as RecordCommitOptions);
    break;
  }
  case 'show': {
    const [name, ref] = positional;
    if (!name || !ref) {
      usage();
      process.exit(1);
    }
    show(getTarget(name), ref);
    break;
  }
  case 'list': {
    const [name] = positional;
    if (!name) {
      usage();
      process.exit(1);
    }
    list(getTarget(name));
    break;
  }
  default:
    usage();
    process.exit(action ? 1 : 0);
}
