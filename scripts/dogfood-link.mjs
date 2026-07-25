#!/usr/bin/env node
// Dev-only tool (never published — not in package.json "files"). Wires THIS repo to
// run its own kit: symlinks .claude/{scripts,skills,agents} into payload/ (so the
// payload stays the single source of truth — edits there are live immediately) and
// writes the two real config files the hooks read. `.claude/` is gitignored;
// regenerate anytime with `pnpm dogfood` (add --force to overwrite the config files).
//
// The settings/config below mirror the wiring the installer's core, lint-fix,
// changesets, and session-context modules produce (cli/modules/*.mjs) — the one place
// to update if a module's hooks change. Kept as inline literals rather than importing
// cli/ internals, so this tool stays robust against CLI refactors.
//
// Single-package tuned (claude-kit is not a monorepo): fix.filterFlag "" so the fix
// hook runs `pnpm run <script>` not `pnpm --filter …`, and the fixers are lint:fix +
// `format` (this repo's prettier script; there is no format:fix). See
// kit.config.example.json `_notes.singlePackage`.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const force = process.argv.includes('--force');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const claudeDir = join(repoRoot, '.claude');

// Relative targets resolve from inside .claude/ (so `..` is the repo root).
const LINKS = [
  { name: 'scripts', target: '../payload/scripts' },
  { name: 'skills', target: '../payload/skills' },
  { name: 'agents', target: '../payload/agents' },
  { name: 'output-styles', target: '../payload/output-styles' },
  { name: 'rules', target: '../payload/rules' },
];

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function ensureLink({ name, target }) {
  const linkPath = join(claudeDir, name);
  const st = lstatOrNull(linkPath);
  if (st) {
    if (!st.isSymbolicLink()) {
      throw new Error(
        `.claude/${name} exists and is not a symlink — refusing to clobber. ` +
          'Move it aside and re-run.',
      );
    }
    if (readlinkSync(linkPath) === target)
      return { action: 'ok', name, target };
    rmSync(linkPath);
    symlinkSync(target, linkPath);
    return { action: 'relinked', name, target };
  }
  symlinkSync(target, linkPath);
  return { action: 'linked', name, target };
}

function ensureFile(name, content) {
  const filePath = join(claudeDir, name);
  const exists = existsSync(filePath);
  if (exists && !force) return { action: 'kept', name };
  writeFileSync(filePath, content);
  return { action: exists ? 'overwrote' : 'wrote', name };
}

const cmd = (script, statusMessage) => {
  const command = `node "$CLAUDE_PROJECT_DIR/.claude/scripts/${script}"`;
  return statusMessage
    ? { type: 'command', command, statusMessage }
    : { type: 'command', command };
};

const kitConfig = {
  version: 2,
  packageManager: 'pnpm',
  fix: {
    runner: 'pnpm',
    filterFlag: '',
    runScriptPrefix: ['run'],
    commands: ['lint:fix', 'format'],
  },
  lintableExtensions: [
    'ts',
    'tsx',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'svelte',
    'md',
    'json',
    'css',
    'html',
  ],
  generatedFilePattern: '/(?:CHANGELOG|BACKLOG)\\.md$',
  guard: {
    gitCommit: true,
    gitPush: true,
    gitStash: true,
    prCreate: true,
    custom: [],
  },
  changesets: { enabled: true, stopCheck: true, baseBranch: 'main' },
  ledger: { enabled: false },
  targets: [
    {
      name: 'claude-kit',
      prefix: 'CLAUDEKIT',
      packageName: 'claude-kit',
      pathPrefix: '',
      sourcePath: '',
      label: 'Claude Kit',
      fixCommands: ['lint:fix', 'format'],
    },
  ],
};

const settings = {
  // The frontmatter `name` from payload/output-styles/kit-terse.md, NOT the filename
  // slug — Claude Code matches outputStyle by name and silently falls back to Default.
  outputStyle: 'Kit Terse',
  permissions: {
    allow: [
      'Bash(git status)',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
    ],
  },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [cmd('guard-bash.mjs')] }],
    Stop: [
      {
        hooks: [
          cmd('lint-format-fix.mjs', 'Running lint/format auto-fix'),
          cmd('changeset-check.mjs'),
        ],
      },
    ],
    SubagentStop: [
      { hooks: [cmd('lint-format-fix.mjs', 'Running lint/format auto-fix')] },
    ],
    SessionStart: [{ hooks: [cmd('session-context.mjs')] }],
  },
};

mkdirSync(claudeDir, { recursive: true });

const results = [];
try {
  for (const link of LINKS) results.push(ensureLink(link));
} catch (err) {
  console.error(`dogfood: ${err.message}`);
  process.exit(1);
}
results.push(
  ensureFile('kit.config.json', `${JSON.stringify(kitConfig, null, 2)}\n`),
);
results.push(
  ensureFile('settings.json', `${JSON.stringify(settings, null, 2)}\n`),
);

for (const r of results) {
  const arrow = r.target ? ` -> ${r.target}` : '';
  console.log(`  ${r.action.padEnd(9)} .claude/${r.name}${arrow}`);
}
console.log(
  '\nDogfood wired. `.claude/` is gitignored — re-run `pnpm dogfood` (or --force) anytime.',
);
