import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 *   parser fixes. `test/workspaces.test.ts` covers the parsers in isolation, this covers
 *   detect through to targets end to end.
 * - `npm-single` is a root package with only `lint:fix`, no TypeScript or changesets, a
 *   pre-existing settings.json carrying a user hook with odd whitespace plus permissions,
 *   and an existing CLAUDE.md.
 * - `pnpm-single` is a single-package pnpm repo with a lockfile and no workspace yaml,
 *   whose fixers are `lint:fix` plus a writing `format` alongside a separate
 *   `format:check`. The shape CLAUDEKIT-4e98d7 broke: `filterFlag` must be empty and the
 *   writing `format` must be detected as a fixer.
 * - `non-js` is a git repo with no package.json.
 */
export type FixtureKind =
  | 'pnpm-monorepo'
  | 'pnpm-flow-monorepo'
  | 'npm-single'
  | 'pnpm-single'
  | 'committed-scripts'
  | 'non-js';

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function gitInit(root: string): void {
  sh(root, 'git', ['init', '-q', '-b', 'main']);
  sh(root, 'git', ['config', 'user.email', 'kit-test@example.com']);
  sh(root, 'git', ['config', 'user.name', 'kit test']);
  sh(root, 'git', ['add', '-A']);
  sh(root, 'git', ['commit', '-qm', 'fixture: initial']);
}

const PKG_SCRIPTS = {
  dev: 'vite dev',
  fix: 'wireit',
  'lint:fix': 'eslint . --fix',
  'format:fix': 'prettier . --write',
  format: 'prettier . --check',
};

/**
 * Builds one synthetic target repo in a fresh mkdtemp directory.
 *
 * @returns The repo root. Callers remove it in test teardown.
 */
export function makeFixture(kind: FixtureKind): string {
  const root = mkdtempSync(join(tmpdir(), `kit-${kind}-`));

  if (kind === 'pnpm-monorepo') {
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
  } else if (kind === 'npm-single') {
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
  } else if (kind === 'pnpm-flow-monorepo') {
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
  } else if (kind === 'pnpm-single') {
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
  } else if (kind === 'committed-scripts') {
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
  } else if (kind === 'non-js') {
    write(root, 'README.md', '# not a js repo\n');
  } else {
    throw new Error(`unknown fixture kind: ${kind}`);
  }

  gitInit(root);
  return root;
}

// The BUILT entry, not the sources: vitest's globalSetup compiles src/ → dist/
// before any suite runs, so this is always current.
const KIT_CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// vitest exports NODE_PATH pointing at pnpm's virtual store, so a child could resolve
// a dependency the fixture never installed and invert any absence-premised test.
function cleanEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.NODE_PATH;
  return env;
}

// Run the kit CLI as a subprocess. → { status, stdout, stderr }
export function runCli(
  args: string[],
  opts: Parameters<typeof spawnSync>[2] = {},
): RunResult {
  return spawnSync(process.execPath, [KIT_CLI, ...args], {
    encoding: 'utf8',
    ...opts,
    env: cleanEnv(opts?.env),
  }) as RunResult;
}

// Run an installed payload script inside a target repo, hook-style (JSON on stdin).
export function runScript(
  root: string,
  rel: string,
  { input = '', args = [] }: { input?: string; args?: string[] } = {},
): RunResult {
  return spawnSync(process.execPath, [join(root, rel), ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
    env: cleanEnv(),
  }) as RunResult;
}

// Deterministic content hash of a tree (skips .git). Used for dry-run purity assertions.
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
