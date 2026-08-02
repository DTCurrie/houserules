import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { onTestFinished } from 'vitest';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runCli, runIn } from './run.js';

/**
 * Which synthetic repo shape to generate.
 *
 * - `pnpm-monorepo` is schoolyard-shaped: workspace yaml, catalog blocks with
 *   `catalogMode: strict`, empty workspace dirs, two packages whose fix scripts diverge
 *   from the root's, a changesets config and two pending changesets but no
 *   `@changesets/cli` devDependency, only settings.local.json, and no CLAUDE.md.
 * - `pnpm-flow-monorepo` covers the workspace-file shapes `pnpm-monorepo` does not: an
 *   inline flow sequence, a `**` glob whose package is nested under an intermediate
 *   directory, and a negation. Each silently produced the wrong package set before the
 *   parser fixes. `workspaces.test.ts` covers the parsers in isolation, this covers detect
 *   through to targets end to end.
 * - `npm-single` is a root package with only `lint:fix`, no TypeScript or changesets, a
 *   pre-existing settings.json carrying a user hook with odd whitespace plus permissions,
 *   and an existing CLAUDE.md.
 * - `pnpm-single` is a single-package pnpm repo with a lockfile and no workspace yaml,
 *   whose fixers are `lint:fix` plus a writing `format` alongside a separate
 *   `format:check`. The shape CLAUDEKIT-4e98d7 broke: `filterFlag` must be empty and the
 *   writing `format` must be detected as a fixer.
 * - `npm-single-prettier` is `npm-single` plus a `prettier` devDependency, so
 *   `ctx.prettier` is true and the `.prettierignore` protection block plans in.
 * - `non-js` is a git repo with no package.json.
 */
type RepoShape =
  | 'pnpm-monorepo'
  | 'pnpm-flow-monorepo'
  | 'npm-single'
  | 'npm-single-prettier'
  | 'pnpm-single'
  | 'committed-scripts'
  | 'non-js';

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function gitInit(root: string): void {
  runIn(root, 'git', ['init', '-q', '-b', 'main']);
  runIn(root, 'git', ['config', 'user.email', 'kit-test@example.com']);
  runIn(root, 'git', ['config', 'user.name', 'kit test']);
  runIn(root, 'git', ['add', '-A']);
  runIn(root, 'git', ['commit', '-qm', 'fixture: initial']);
}

const PKG_SCRIPTS = {
  dev: 'vite dev',
  fix: 'wireit',
  'lint:fix': 'eslint . --fix',
  'format:fix': 'prettier . --write',
  format: 'prettier . --check',
};

/**
 * A bare synthetic repo with no kit installed, removed after the current test.
 *
 * Reach for {@link useInstalledRepo} instead unless the test's subject is `init` itself, since
 * staging by running `init` couples the suite to a command it is not testing.
 *
 * @returns The repo root, removed after the current test including on failure.
 */
export function useRepo(shape: RepoShape): string {
  const root = buildRepo(shape);
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * A repo with the kit ALREADY INSTALLED, staged by copying a snapshot rather than by
 * running `init`.
 *
 * Prefer this everywhere. Staging by running `init` makes a suite fail when `init` breaks,
 * naming the wrong subject. The copy preserves the git index byte for byte, which `update`'s
 * untracking tests depend on.
 *
 * Use {@link useRepo} plus a real `init` when the subject IS `init`, or when the test re-runs
 * `init` over a tree it has already mutated.
 *
 * @param opts.modules Passed through as `--modules=`. Part of the cache key.
 * @returns The repo root, removed after the current test.
 */
export function useInstalledRepo(
  shape: RepoShape,
  opts: { modules?: string } = {},
): string {
  const key = `${shape}::${opts.modules ?? ''}`;
  const snapshot = join(snapshotRoot(), key.replace(/[^a-z0-9]+/gi, '_'));

  // On disk, not a module-level Map: vitest gives every test FILE a fresh module registry, so
  // an in-memory cache never survives across files and each would clobber the shared snapshot.
  if (!existsSync(snapshot)) {
    const staging = buildRepo(shape);
    const args = ['init', '--yes'];
    if (opts.modules) args.push(`--modules=${opts.modules}`);
    const result = runCli([...args, staging]);
    if (result.status !== 0) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(
        `useInstalledRepo(${key}) could not stage: init exited ${result.status}\n${result.stderr}`,
      );
    }
    // Publish atomically. Two workers can miss the same key at once, so each builds into a
    // private directory and the first rename wins. A loser's rename fails with ENOTEMPTY,
    // which is success: the winner published an equivalent tree from the same CLI.
    const pending = `${snapshot}.${process.pid}.pending`;
    cpSync(staging, pending, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    try {
      renameSync(pending, snapshot);
    } catch {
      rmSync(pending, { recursive: true, force: true });
    }
  }

  const root = mkdtempSync(join(tmpdir(), `kit-${shape}-`));
  cpSync(snapshot, root, { recursive: true });
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// global-setup.ts creates this and removes it in teardown. Falling back to a local
// mkdtemp keeps a directly-invoked suite working, at the cost of leaving one temp dir.
function snapshotRoot(): string {
  const fromSetup = process.env.KIT_TEST_SNAPSHOT_ROOT;
  if (fromSetup) {
    mkdirSync(fromSetup, { recursive: true });
    return fromSetup;
  }
  return mkdtempSync(join(tmpdir(), 'kit-snapshots-'));
}

/** Writes one shape into a fresh mkdtemp directory. Callers own the cleanup. */
function buildRepo(shape: RepoShape): string {
  const root = mkdtempSync(join(tmpdir(), `kit-${shape}-`));

  if (shape === 'pnpm-monorepo') {
    write(
      root,
      'pnpm-workspace.yaml',
      [
        'packages:',
        '  - packages/*',
        '  - toolkits/*',
        '  - games/*',
        '  - apps/*',
        '',
        'catalogMode: strict',
        '',
        'catalog:',
        "  typescript: '6.0.3'",
        '',
        'catalogs:',
        '  three-stack:',
        "    three: '0.160.0'",
        '',
      ].join('\n'),
    );
    write(
      root,
      'package.json',
      json({
        name: 'fix-root',
        private: true,
        packageManager: 'pnpm@11.5.0',
        scripts: {
          build: 'wireit',
          verify: 'wireit',
          fix: 'wireit',
          'format:check': 'prettier --check .',
          change: 'pnpx @changesets/cli',
        },
        devDependencies: { typescript: 'catalog:' },
      }),
    );
    write(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    write(root, 'packages/.gitkeep', '');
    write(root, 'toolkits/.gitkeep', '');
    write(
      root,
      'apps/studio/package.json',
      json({ name: '@fix/studio', private: true, scripts: PKG_SCRIPTS }),
    );
    write(root, 'apps/studio/src/main.ts', 'export const app = 1;\n');
    write(
      root,
      'games/cityville/package.json',
      json({ name: '@fix/cityville', private: true, scripts: PKG_SCRIPTS }),
    );
    write(root, 'games/cityville/src/game.ts', 'export const game = 1;\n');
    write(
      root,
      '.changeset/config.json',
      json({
        changelog: '@changesets/cli/changelog',
        commit: false,
        access: 'restricted',
        baseBranch: 'main',
      }),
    );
    write(root, '.changeset/README.md', '# Changesets\n');
    write(
      root,
      '.changeset/fuzzy-pandas-smile.md',
      '---\n"@fix/studio": patch\n---\n\nPending one.\n',
    );
    write(
      root,
      '.changeset/brave-lions-jump.md',
      '---\n"@fix/cityville": minor\n---\n\nPending two.\n',
    );
    write(
      root,
      '.claude/settings.local.json',
      json({ permissions: { allow: ['WebFetch(domain:example.com)'] } }),
    );
  } else if (shape === 'npm-single') {
    write(
      root,
      'package.json',
      json({
        name: 'single-app',
        version: '1.0.0',
        scripts: { 'lint:fix': 'eslint . --fix', test: 'node --test' },
      }),
    );
    write(
      root,
      'package-lock.json',
      json({ name: 'single-app', lockfileVersion: 3 }),
    );
    write(root, 'src/index.js', 'module.exports = 1;\n');
    write(
      root,
      'CLAUDE.md',
      '# single-app\n\nPre-existing user CLAUDE.md — the kit must never edit this.\n',
    );
    write(
      root,
      '.claude/settings.json',
      `${JSON.stringify(
        {
          permissions: { allow: ['Bash(echo hi)'] },
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  { type: 'command', command: 'node   ./my-hook.js   --check' },
                ],
              },
            ],
          },
        },
        null,
        4,
      )}\n`,
    );
  } else if (shape === 'npm-single-prettier') {
    write(
      root,
      'package.json',
      json({
        name: 'single-app-prettier',
        version: '1.0.0',
        scripts: { 'lint:fix': 'eslint . --fix', test: 'node --test' },
        devDependencies: { prettier: '^3.0.0' },
      }),
    );
    write(root, 'src/index.js', 'module.exports = 1;\n');
  } else if (shape === 'pnpm-flow-monorepo') {
    write(
      root,
      'pnpm-workspace.yaml',
      'packages: ["libs/**", "!libs/legacy"]\n',
    );
    write(
      root,
      'package.json',
      json({
        name: 'flow-root',
        private: true,
        packageManager: 'pnpm@11.5.0',
        scripts: { 'lint:fix': 'eslint . --fix' },
      }),
    );
    write(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    // Nested one level deeper than any `*` glob reaches. Only `**` finds it.
    write(
      root,
      'libs/group/nested/package.json',
      json({ name: '@flow/nested', scripts: PKG_SCRIPTS }),
    );
    write(root, 'libs/group/nested/src/index.ts', 'export const x = 1;\n');
    write(
      root,
      'libs/plain/package.json',
      json({ name: '@flow/plain', scripts: PKG_SCRIPTS }),
    );
    write(
      root,
      'libs/legacy/package.json',
      json({ name: '@flow/legacy', scripts: PKG_SCRIPTS }),
    );
  } else if (shape === 'pnpm-single') {
    write(
      root,
      'package.json',
      json({
        name: 'solo',
        version: '1.0.0',
        scripts: {
          'lint:fix': 'eslint . --fix',
          format: 'prettier --write .',
          'format:check': 'prettier --check .',
          test: 'node --test',
        },
      }),
    );
    write(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    write(root, 'src/index.js', 'export const x = 1;\n');
  } else if (shape === 'committed-scripts') {
    // The state every pre-gitignore install is in: kit scripts tracked by git.
    // gitInit() commits everything below, so these land in the index. This is what
    // the migration has to detect and stage out.
    write(
      root,
      'package.json',
      json({ name: 'legacy-install', version: '1.0.0' }),
    );
    for (const name of [
      'changeset-check.mjs',
      'session-context.mjs',
      'guard-bash.mjs',
    ]) {
      write(root, `.claude/scripts/${name}`, '#!/usr/bin/env node\n');
    }
    write(root, '.claude/settings.json', json({ hooks: {} }));
  } else if (shape === 'non-js') {
    write(root, 'README.md', '# not a js repo\n');
  } else {
    throw new Error(`unknown repo shape: ${shape}`);
  }

  gitInit(root);
  return root;
}

/** Content hash of a whole tree, ignoring `.git`. Asserts a dry run wrote nothing. */
export function treeHash(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === '.git') continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else {
        hash.update(abs.slice(root.length));
        hash.update(readFileSync(abs));
      }
    }
  };
  walk(root);
  return hash.digest('hex');
}
