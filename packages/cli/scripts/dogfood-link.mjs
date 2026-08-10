#!/usr/bin/env node
/**
 * Dev-only tool, never published. Wires this repo to run its own kit by seeding
 * `.claude/kit.config.json` and `.claude/settings.json`, then running the real installer
 * (`node dist/cli.js init --yes`) over this repo's own workspace. `.claude/` is gitignored.
 *
 * This runs the SAME plan/apply pipeline a user's `init` runs: every module's `plan()`
 * executes for real, `.claude/kit-manifest.json` records what it installed, and an
 * option-gated reference doc only appears when the module option that ships it was chosen.
 *
 * A relink pass then runs AFTER apply (see `relink()` below): any manifest-tracked
 * destination whose bytes are an exact, unique match for a payload source is swapped back
 * to a symlink at that source, so a payload prose edit shows up in `.claude/` immediately,
 * with no rebuild and no re-run of this script. Compiled scripts, `appendBody` rules, and
 * anything the kit only owns part of stay real, copied files. `doctor` sees no drift either
 * way: a symlink reads through to the same bytes the manifest recorded.
 *
 * Usage: `pnpm dogfood`, with `--force` to overwrite an existing kit.config.json/settings.json
 * seed. Safe to re-run: a second run with the same inputs writes nothing new.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const force = process.argv.includes('--force');
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..');
const packagesDir = join(repoRoot, 'packages');
const claudeDir = join(repoRoot, '.claude');
const cliEntry = join(packageRoot, 'dist', 'cli.js');

if (!existsSync(cliEntry)) {
  console.error(
    `${cliEntry} is missing — run \`pnpm build\` first, then re-run dogfood.`,
  );
  process.exit(1);
}

/**
 * `pnpm-workspace.yaml` declares this one package outside the `packages/*` glob, so it never
 * turns up under a plain `readdirSync(packagesDir)`. `detect.ts`'s `listWorkspacePackages`
 * reads the workspace file directly and picks it up, which is what makes `init`'s own
 * `ctx.targets` fifteen entries while this seed's `buildTargets()` used to stop at fourteen —
 * a managed-region drift between `init` and `doctor` on every dogfood run.
 */
const EXTRA_WORKSPACE_PACKAGE_DIRS = ['cli/test/plugin-fixture'];

/**
 * Every workspace package, the CLI first: everything directly under `packages/` plus the
 * extra paths `pnpm-workspace.yaml` names individually.
 *
 * Used to build the `targets` array this repo's own `kit.config.json` seed carries. That
 * array is what `verify-changed.mjs` and the backlog scripts read at RUNTIME, since the CLI's
 * own `init` derives its working `Ctx.targets` from the tree directly and never consults this
 * file's `targets` for that purpose.
 */
function allPackages() {
  const direct = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(packagesDir, name, 'package.json')));
  return [...direct, ...EXTRA_WORKSPACE_PACKAGE_DIRS].sort((a, b) =>
    a === 'cli' ? -1 : b === 'cli' ? 1 : a.localeCompare(b),
  );
}

/** Every workspace package carrying a `payload/`, the CLI first. Only these can be plugins. */
function payloadPackages() {
  return allPackages().filter((name) =>
    existsSync(join(packagesDir, name, 'payload')),
  );
}

/**
 * Maps each entry under `rel` (one of `LINK_SURFACES`) to the one package that contributes
 * it, so the relink pass below can find, for a given `.claude/` destination, the single
 * payload source it structurally corresponds to.
 *
 * Descends into a directory only when more than one package contributes that same name.
 * A directory only one package owns stays a single entry at that level (`skills/backlog-add`
 * for the whole skill directory, not `skills/backlog-add/SKILL.md`), which is why the relink
 * pass below walks up from a destination to find the owning entry rather than expecting an
 * exact match.
 *
 * @throws Error when two packages contribute the same FILE. A real id collision, and
 *   letting one silently win would hide it rather than fail the run.
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

function shortName(pkgName, dir) {
  const short = pkgName?.includes('/') ? pkgName.split('/').pop() : pkgName;
  return (short || dir).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function suggestPrefix(pkgName) {
  const short = pkgName.includes('/')
    ? (pkgName.split('/').pop() ?? pkgName)
    : pkgName;
  const cleaned = short.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prefix = cleaned.replace(/^[0-9]+/, '').slice(0, 12);
  return prefix || 'PKG';
}

function titleCase(s) {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Mirrors `detectVerifyCommands` in `src/detect.ts`, close enough for a seed: a package's
 * `check` and `test` scripts, in that order. `@agent-kit/test` and `plugin-testing` are the
 * only two of fourteen packages with no `test` script, so this naturally leaves them at
 * `["check"]`, which is what step 5 of the brief asked for by name.
 */
function verifyCommandsFor(scripts) {
  const out = [];
  if (typeof scripts.check === 'string') out.push('check');
  if (typeof scripts.test === 'string') out.push('test');
  return out;
}

/**
 * One `KitConfigTarget` per workspace package, for `verify-changed.mjs` and the backlog
 * scripts to read at runtime. `fixCommands` is left unset for all of them: this repo's
 * lint/format fixers live only at the workspace root (`lint:fix`, `format`), never per
 * package, which is exactly what the top-level `fix` block below already covers.
 */
function buildTargets() {
  return allPackages().map((dir) => {
    const pkgPath = join(packagesDir, dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const name = shortName(pkg.name, dir);
    return {
      name,
      prefix: suggestPrefix(pkg.name ?? dir),
      packageName: pkg.name ?? dir,
      pathPrefix: `packages/${dir}/`,
      sourcePath: existsSync(join(packagesDir, dir, 'src'))
        ? `packages/${dir}/src`
        : `packages/${dir}`,
      label: titleCase(name),
      verifyCommands: verifyCommandsFor(pkg.scripts ?? {}),
    };
  });
}

/**
 * The plugins this repo actually loads, by relative path, and their alias. The authority
 * for which of the ten payload docs are reachable and which of the eighteen rules install:
 * a plugin absent here contributes nothing, no matter what it ships.
 */
const PLUGINS = [
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
  { name: './packages/plugin-github', alias: 'github' },
];

/**
 * The explicit module set this repo installs. Deliberately not "every module every plugin
 * ships": `reviewers`, `debug-session`, `ready`, `sweep`, `read-guard`, `regen`, `statusline`,
 * `ci-settings`, `accessibility-review`, `design-review`, `svelte-mcp`, and `pr-description`
 * are all real modules this repo does not turn on, because nothing in this repo's own
 * CLAUDE.md or workflow evidences them.
 *
 * `core`, `lint-fix`, `session-context`, and `rename` are `defaultEnabled` for this repo
 * already (TypeScript, fix scripts, always-on) and are listed anyway for clarity, since
 * `--modules` is additive and re-listing a default is a no-op.
 *
 * `code-cleanliness`, `plans`, and `orchestrate` are optional but this repo's own CLAUDE.md
 * names their surfaces directly: the `code-cleanliness.md` rule it says it obeys, the
 * `.claude/plans/<name>/` workspaces its plan docs reference, and the `/orchestrate` skill
 * the "Exception" bullet under Cost & verification discipline names. `verify-changed` is
 * added per the brief's fixed seam (step 5).
 *
 * Every other entry installs one plugin's rule/reference set for real, chosen so the
 * eighteen rules this repo's CLAUDE.md says it carries all actually install, and so the
 * option-gated reference docs (design-game-*, design-tailwind-theming, three-performance)
 * get a real, reachable install to prove the appendBody routing tails work end to end.
 */
const MODULES = [
  'core',
  'lint-fix',
  'session-context',
  'rename',
  'code-cleanliness',
  'plans',
  'orchestrate',
  'verify-changed',
  'a11y/accessibility',
  'cs/changesets',
  'prose/code-comments',
  'prose/prose-voice',
  'prose/output-prose',
  'svelte/svelte',
  'testing/testing',
  'ts/typescript',
  'three/three',
  'design/design',
  'design/design-game',
  'backlog/backlog',
  'decisions/decisions',
  'github/projects',
];

/**
 * Option selections for the modules above that carry them. `a11y/accessibility` picks all
 * four framework guides so all five accessibility rules install. `three/three` and
 * `svelte/svelte` pick every framework guide this repo could plausibly need plus the
 * performance reference. `design/design-game` picks both game references specifically
 * because the acceptance check for this phase greps for `design-game-hud.md`'s routing tail.
 *
 * `design/design-tailwind` is deliberately NOT in the module set above. It needs `tailwindcss`
 * and `@tailwindcss/oxide` to do anything, this repo is not a Tailwind app, and installing it
 * anyway made `doctor` warn twice on every run about dependencies nobody here should add. A
 * dogfooded tree is only useful as acceptance if it represents an install someone would really
 * choose.
 */
const MODULE_OPTIONS = {
  'a11y/accessibility': ['html', 'react', 'svelte', 'vue'],
  'svelte/svelte': ['sveltekit'],
  'testing/testing': ['typescript', 'javascript'],
  'three/three': ['threlte', 'r3f', 'performance'],
  'design/design-game': ['hud', 'visual'],
};

const kitConfig = {
  version: 2,
  packageManager: 'pnpm',
  // This repo's lint/format fixers live only at the workspace root (`lint:fix`, `format`),
  // never per package, so `filterFlag` stays empty: the fixer runs once over the whole tree
  // rather than being scoped with `--filter <pkg>`.
  fix: {
    runner: 'pnpm',
    filterFlag: '',
    runScriptPrefix: ['run'],
    commands: ['lint:fix', 'format'],
  },
  // Fixed seam (brief step 5): `verify-changed.mjs` scopes this per changed package with
  // `--filter`, unlike the fixer above, since every package (bar the two named in
  // `verifyCommandsFor`) has its own `check`/`test` scripts to run in isolation.
  verify: {
    runner: 'pnpm',
    filterFlag: '--filter',
    runScriptPrefix: ['run'],
    commands: ['check', 'test'],
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
  // `changesets.enabled` agrees with `cs/changesets` being in MODULES above.
  changesets: { enabled: true, stopCheck: true, baseBranch: 'main' },
  // Ledger SYNC to GitHub Projects, not the backlog/decisions plugins (`backlog/backlog`,
  // `decisions/decisions` above, which need no sync permission to work locally). Off: this
  // worktree has no maintainer bootstrap token.
  ledger: { enabled: false },
  plugins: PLUGINS,
  targets: buildTargets(),
};

const settings = {
  // Never written by the installer itself (`output-prose`'s module comment: "the kit never
  // writes outputStyle into settings.json, which would clobber the user's choice"), so it is
  // seeded here, before init runs, the same way kit.config.json is. The frontmatter `name`
  // from payload/output-styles/output-prose.md, NOT the filename slug: Claude Code matches
  // outputStyle by name and silently falls back to Default on a mismatch.
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
};

function ensureFile(name, content) {
  const filePath = join(claudeDir, name);
  const exists = existsSync(filePath);
  if (exists && !force) return { action: 'kept', name };
  writeFileSync(filePath, content);
  return { action: exists ? 'overwrote' : 'wrote', name };
}

mkdirSync(claudeDir, { recursive: true });

// kit.config.json is rewritten every run, not seeded once. Its `plugins` list and the
// `--modules` flag below are two halves of one definition, so keeping a stale config while
// passing modules from the current literal fails with "Unknown module <alias>/<id>".
const results = [
  (() => {
    const filePath = join(claudeDir, 'kit.config.json');
    const existed = existsSync(filePath);
    writeFileSync(filePath, `${JSON.stringify(kitConfig, null, 2)}\n`);
    return { action: existed ? 'rewrote' : 'wrote', name: 'kit.config.json' };
  })(),
  ensureFile('settings.json', `${JSON.stringify(settings, null, 2)}\n`),
];
for (const r of results) {
  console.log(`  ${r.action.padEnd(9)} .claude/${r.name}`);
}

const moduleOptionArgs = Object.entries(MODULE_OPTIONS).flatMap(
  ([id, values]) => ['--module-option', `${id}=${values.join(',')}`],
);

const initArgs = [
  cliEntry,
  'init',
  repoRoot,
  '--yes',
  `--modules=${MODULES.join(',')}`,
  ...moduleOptionArgs,
];

/**
 * The surfaces the relink pass considers. Deliberately the same five `apply()` writes as
 * whole-file or body copies from a plugin's own `payload/`, minus `scripts`: a payload
 * script resolves `./lib/` from its own real path, which a symlink at a different real path
 * would break, so scripts stay copied unconditionally (brief step 3).
 */
const LINK_SURFACES = [
  'skills',
  'agents',
  'output-styles',
  'rules',
  'reference',
];

console.log(
  `\nRunning the real installer: node ${initArgs.slice(1).join(' ')}\n`,
);
execFileSync(process.execPath, initArgs, { stdio: 'inherit', cwd: repoRoot });

/** Files the kit only owns PART of. Never relinked, whatever surface they happen to sit in. */
const SHARED_HOST_FILES = new Set([
  '.claude/settings.json',
  'CLAUDE.md',
  '.gitignore',
  '.prettierignore',
]);

/**
 * Walks from `relPath` up to its owning entry in `owners` (a directory entry, e.g.
 * `skills/backlog-add`, or an exact file entry, e.g. `rules/typescript.md`), and returns the
 * package plus the payload-relative source path — always `relPath` itself, since the owning
 * entry only proves that package is the SOLE contributor somewhere on the path from
 * `relPath` up to `rel`, not that it renamed anything under it.
 */
function findPayloadSource(relPath, owners) {
  const segments = relPath.split('/');
  for (let depth = segments.length; depth > 0; depth--) {
    const candidate = segments.slice(0, depth).join('/');
    const pkg = owners.get(candidate);
    if (pkg)
      return { pkg, srcPath: join(packagesDir, pkg, 'payload', relPath) };
  }
  return null;
}

/** Exact-byte equality, the only condition the brief allows a relink under (step 2). */
function sameBytes(a, b) {
  return a.length === b.length && a.equals(b);
}

/**
 * Runs AFTER apply, over what `.claude/kit-manifest.json` says the install just wrote.
 * Swaps a destination back to a symlink at its payload source when the two are byte-identical
 * and the source is the one this destination structurally corresponds to (its `.claude/`-relative
 * path, resolved against `owners`). Everything else — an `appendBody` routing tail, a script, a
 * host file, a destination with no single owning source — stays a real, copied file, and is
 * reported as such: a silent skip here is how someone edits a payload rule for ten minutes
 * without it taking effect.
 */
function relink() {
  const manifestPath = join(claudeDir, 'kit-manifest.json');
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const owners = new Map();
  for (const surface of LINK_SURFACES) {
    for (const [rel, pkg] of resolveOwners(
      'payload',
      surface,
      payloadPackages(),
    )) {
      owners.set(rel, pkg);
    }
  }

  let relinked = 0;
  let alreadyLive = 0;
  let scriptsCopied = 0;
  const kept = [];

  for (const dest of Object.keys(manifest.files)) {
    if (dest.startsWith('.claude/scripts/')) {
      scriptsCopied++;
      continue;
    }
    if (SHARED_HOST_FILES.has(dest)) continue;
    if (!dest.startsWith('.claude/')) continue;
    const relPath = dest.slice('.claude/'.length);
    if (!LINK_SURFACES.includes(relPath.split('/')[0])) continue;

    const fullDest = join(repoRoot, dest);
    if (lstatSync(fullDest).isSymbolicLink()) {
      alreadyLive++;
      continue;
    }

    const source = findPayloadSource(relPath, owners);
    if (!source) {
      kept.push({ dest, reason: 'no single payload source owns this path' });
      continue;
    }
    if (!existsSync(source.srcPath)) {
      kept.push({ dest, reason: `payload source missing: ${source.srcPath}` });
      continue;
    }

    const destBytes = readFileSync(fullDest);
    const srcBytes = readFileSync(source.srcPath);
    if (sameBytes(destBytes, srcBytes)) {
      const up = '../'.repeat(relPath.split('/').length);
      rmSync(fullDest);
      symlinkSync(`${up}packages/${source.pkg}/payload/${relPath}`, fullDest);
      relinked++;
      continue;
    }

    const reason = destBytes.includes(srcBytes)
      ? 'appendBody routing tail appended (body action, kit-owned frontmatter split)'
      : 'content differs from its payload source (locally edited, or frontmatter customized)';
    kept.push({ dest, reason });
  }

  console.log(
    `\nRelink: ${relinked} destination(s) now read live from payload, ${alreadyLive} already did, ` +
      `${scriptsCopied} compiled script(s) stay copied (resolve ./lib/ from their own real path), ` +
      `${kept.length} stayed real files.`,
  );
  for (const { dest, reason } of kept)
    console.log(`  kept ${dest} — ${reason}`);
}

relink();

console.log(
  '\nDogfood wired via the real installer. `.claude/` is gitignored — re-run `pnpm dogfood` anytime.',
);
