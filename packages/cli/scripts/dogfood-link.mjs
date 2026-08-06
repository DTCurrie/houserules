#!/usr/bin/env node
/**
 * Dev-only tool, never published. Wires this repo to run its own kit by symlinking
 * .claude/{scripts,skills,agents} into this package's payload/, so the payload stays the
 * single source of truth and edits there are live immediately, and by writing the two real
 * config files the hooks read. `.claude/` is gitignored.
 *
 * `.claude/` lives at the WORKSPACE root, because that is where Claude Code looks. The
 * payload lives in this package. The link targets bridge the two.
 *
 * Usage: `pnpm dogfood`, with `--force` to overwrite the config files.
 *
 * The settings and config below mirror the wiring the installer's core, lint-fix,
 * changesets, and session-context modules produce. This is the one place to update when a
 * module's hooks change. They are inline literals rather than imports of `src/` internals,
 * so this tool stays robust against CLI refactors.
 */
// Single-package tuned, so fix.filterFlag is "" and the fix hook runs
// `pnpm run <script>`. See kit.config.example.json `_notes.singlePackage`.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const force = process.argv.includes('--force');
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..');
const packagesDir = join(repoRoot, 'packages');
const claudeDir = join(repoRoot, '.claude');

// The surfaces Claude Code reads, and which payload root each is assembled from. `scripts`
// comes from BUILD OUTPUT, so a .mts edit is not live until `pnpm dogfood:watch` compiles it.
// Everything else links straight at sources and is live on save.
const SURFACES = [
  // Scripts are COPIED, not linked. A payload script imports its siblings relatively
  // (`./lib/kit-config.mjs`), and node resolves that from the symlink's real path, not from
  // where the link sits. A plugin deliberately ships no `lib/`, since core installs it, so a
  // linked plugin script cannot find the substrate. A real install copies files, which puts
  // them side by side. Copying here reproduces that. Nothing is lost: scripts are build output
  // and already need a recompile plus a re-run to go live.
  { name: 'scripts', from: 'payload-dist', mode: 'copy' },
  { name: 'skills', from: 'payload', mode: 'link' },
  { name: 'agents', from: 'payload', mode: 'link' },
  { name: 'output-styles', from: 'payload', mode: 'link' },
  { name: 'rules', from: 'payload', mode: 'link' },
  { name: 'reference', from: 'payload', mode: 'link' },
];

/**
 * Every workspace package carrying a payload, the CLI first.
 *
 * Discovered rather than listed, because the whole point of the plugin split is that a surface
 * like `.claude/rules/` is now assembled from several packages at once. A hardcoded list would
 * go stale the next time a module moves.
 */
function payloadPackages() {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => (a === 'cli' ? -1 : b === 'cli' ? 1 : a.localeCompare(b)))
    .filter((name) => existsSync(join(packagesDir, name, 'payload')));
}

if (!existsSync(join(packageRoot, 'payload-dist', 'scripts'))) {
  console.error(
    'payload-dist/scripts is missing — run `pnpm build` first, then re-run dogfood.',
  );
  process.exit(1);
}

/**
 * Maps each entry under `rel` to the one package that contributes it.
 *
 * Descends into a directory only when more than one package contributes that same name, which is
 * how `scripts/lib/` merges the CLI's shared libs with a plugin's own. A directory only one
 * package owns stays a single entry, so a file added inside it is live without re-running.
 *
 * @throws Error when two packages contribute the same FILE. That is a real id collision the
 *   resolver would also reject, and silently letting one win would hide it.
 */
function resolveOwners(from, rel, packages) {
  const byEntry = new Map();
  for (const pkg of packages) {
    const source = join(packagesDir, pkg, from, rel);
    if (!existsSync(source)) continue;
    for (const dirent of readdirSync(source, { withFileTypes: true })) {
      if (!byEntry.has(dirent.name)) byEntry.set(dirent.name, []);
      byEntry.get(dirent.name).push({ pkg, isDir: dirent.isDirectory() });
    }
  }

  const owners = new Map();
  for (const [entry, contributors] of byEntry) {
    const entryRel = `${rel}/${entry}`;
    if (contributors.length === 1) {
      owners.set(entryRel, contributors[0].pkg);
      continue;
    }
    // Two packages naming the same FILE is a real id collision the resolver would also reject.
    // Two naming the same DIRECTORY is not: `scripts/lib/` legitimately merges the CLI's shared
    // libs with a plugin's own, exactly as a real install's per-file copies do.
    if (!contributors.every((contributor) => contributor.isDir)) {
      const names = contributors
        .map((contributor) => contributor.pkg)
        .join(' and ');
      throw new Error(
        `both ${names} contribute ${entryRel} — resolve the collision before dogfooding`,
      );
    }
    for (const [childRel, pkg] of resolveOwners(
      from,
      entryRel,
      contributors.map((contributor) => contributor.pkg),
    )) {
      owners.set(childRel, pkg);
    }
  }
  return owners;
}

/**
 * Assembles one `.claude/<surface>/` directory from every package that contributes to it.
 *
 * Per-entry rather than one directory symlink, because a surface is no longer owned by a single
 * package. `.claude/rules/` draws from the CLI and from the prose and testing plugins at once,
 * and a directory symlink can only point at one of them.
 */
function linkSurface({ name, from, mode }) {
  // Resolved BEFORE anything is removed. This throws on a genuine collision, and a surface
  // destroyed by a run that then aborted leaves the repo's own hooks pointing at files that no
  // longer exist, which turns "dogfood refused" into "this session is broken".
  const owners = resolveOwners(from, name, payloadPackages());
  if (owners.size === 0) return { action: 'empty', name };

  const surfaceDir = join(claudeDir, name);
  // Rebuilt every run. It holds nothing but links and copies this script created, so removing it
  // cannot lose work, and a stale link to a moved payload is worse than a missing one.
  rmSync(surfaceDir, { recursive: true, force: true });
  mkdirSync(surfaceDir, { recursive: true });

  for (const [rel, pkg] of owners) {
    const dest = join(claudeDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (mode === 'copy') {
      cpSync(join(packagesDir, pkg, from, rel), dest, { recursive: true });
      continue;
    }
    // Resolved from the link's own directory, which sits `rel`-deep under the repo root once
    // `.claude/` is counted, so a nested entry needs one more `..` than a top-level one.
    const up = '../'.repeat(rel.split('/').length);
    symlinkSync(`${up}packages/${pkg}/${from}/${rel}`, dest);
  }

  const packages = [...new Set(owners.values())];
  return {
    action: mode === 'copy' ? 'copied' : 'linked',
    name,
    target: `${owners.size} entries from ${packages.join(', ')}`,
  };
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
  // Declared so this repo's own doctor resolves them for real, the same way a consumer's
  // would. The symlinks above are what makes edits live, but the config has to be honest or
  // the one repo that dogfoods the kit never exercises plugin resolution.
  plugins: [
    { name: './packages/plugin-backlog', alias: 'backlog' },
    { name: './packages/plugin-decisions', alias: 'decisions' },
    { name: './packages/plugin-changesets', alias: 'cs' },
    { name: './packages/plugin-prose', alias: 'prose' },
    { name: './packages/plugin-testing', alias: 'testing' },
    { name: './packages/plugin-accessibility', alias: 'a11y' },
    { name: './packages/plugin-typescript', alias: 'ts' },
    { name: './packages/plugin-three', alias: 'three' },
    { name: './packages/plugin-svelte', alias: 'svelte' },
    { name: './packages/plugin-design', alias: 'design' },
  ],
  targets: [
    {
      name: 'agent-kit',
      prefix: 'AGENTKIT',
      packageName: '@agent-kit/cli',
      pathPrefix: 'packages/cli/',
      sourcePath: 'packages/cli/src',
      label: 'Agent Kit',
      fixCommands: ['lint:fix', 'format'],
    },
  ],
};

const settings = {
  // The frontmatter `name` from payload/output-styles/output-prose.md, NOT the filename
  // slug. Claude Code matches outputStyle by name and silently falls back to Default.
  outputStyle: 'Prose',
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
    // No SubagentStop fixer. renderKitConfig ships `fix.onSubagentStop: false` because
    // parallel workers would each fix every package at once and clobber each other
    // mid-edit. Dogfood has to match the default the kit installs, or this repo is the one
    // place that never exercises it. The parent Stop hook covers the same ground.
    SessionStart: [{ hooks: [cmd('session-context.mjs')] }],
  },
};

mkdirSync(claudeDir, { recursive: true });

const results = [];
try {
  for (const surface of SURFACES) results.push(linkSurface(surface));
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
