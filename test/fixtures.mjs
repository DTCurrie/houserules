// Synthetic target-repo fixtures (claude-kit tests). Generated into mkdtemp dirs;
// callers rm them in test teardown.
//
// F1 pnpm-monorepo — schoolyard-shaped: workspace yaml with catalog blocks +
//    catalogMode: strict, EMPTY workspace dirs, two packages whose fix scripts
//    diverge from the root's, changesets config + 2 pending changesets but NO
//    @changesets/cli devDependency (root script uses pnpx), settings.local.json
//    only, no CLAUDE.md.
// F2 npm-single — root package with only lint:fix, no TS/changesets, pre-existing
//    settings.json with a user hook (odd whitespace) + permissions, existing CLAUDE.md.
// F3 non-js — git repo, no package.json.

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

export function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function gitInit(root) {
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

export function makeFixture(kind) {
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
  } else if (kind === 'non-js') {
    write(root, 'README.md', '# not a js repo\n');
  } else {
    throw new Error(`unknown fixture kind: ${kind}`);
  }

  gitInit(root);
  return root;
}

const KIT_CLI = join(
  dirname(new URL(import.meta.url).pathname),
  '..',
  'cli',
  'index.mjs',
);

// Run the kit CLI as a subprocess. → { status, stdout, stderr }
export function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [KIT_CLI, ...args], {
    encoding: 'utf8',
    ...opts,
  });
}

// Run an installed payload script inside a target repo, hook-style (JSON on stdin).
export function runScript(root, rel, { input = '', args = [] } = {}) {
  return spawnSync(process.execPath, [join(root, rel), ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
  });
}

// Deterministic content hash of a tree (skips .git) — dry-run purity assertions.
export function treeHash(root) {
  const hash = createHash('sha256');
  const walk = (dir) => {
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
