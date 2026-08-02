import { expect, test } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { makeFixture, runCli, runScript } from './fixtures.js';

const SCRIPT = '.claude/scripts/changeset-write.mjs';

// @changesets/write resolves through @changesets/cli, because pnpm-style strict
// layouts do not hoist transitive deps. The script refuses to author without it.
function linkChangesetsCli(root: string): void {
  const cliDir = dirname(
    createRequire(import.meta.url).resolve('@changesets/cli/package.json'),
  );
  mkdirSync(join(root, 'node_modules/@changesets'), { recursive: true });
  symlinkSync(cliDir, join(root, 'node_modules/@changesets/cli'));
}

function newChangesets(root: string, before: Set<string>): string[] {
  return readdirSync(join(root, '.changeset')).filter(
    (f) => f.endsWith('.md') && !before.has(f),
  );
}

test('CW1: writes a valid changeset via @changesets/write for known packages', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    linkChangesetsCli(root);
    const before = new Set(readdirSync(join(root, '.changeset')));

    const r = runScript(root, SCRIPT, {
      args: [
        '--pkg',
        '@fix/cityville:minor',
        '--pkg',
        '@fix/studio',
        '--summary',
        'Add road planning; fixes CITYVILLE-abc123.',
      ],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim(), 'human-id filename from @changesets/write').toMatch(
      /^\.changeset\/[a-z][a-z-]*\.md$/,
    );

    const [file] = newChangesets(root, before);
    const text = readFileSync(join(root, '.changeset', file), 'utf8');
    expect(text, text).toMatch(
      /^---\n['"]@fix\/cityville['"]: minor\n['"]@fix\/studio['"]: patch\n---\n\nAdd road planning/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CW2: validation — unknown package, bad level, --empty, stdin summary', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    linkChangesetsCli(root);
    let r = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/nope', '--summary', 'x'],
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Unknown package "@fix\/nope"/);
    expect(r.stderr).toMatch(
      /@fix\/cityville, @fix\/studio|@fix\/studio, @fix\/cityville/,
    );

    r = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio', '--level', 'huge', '--summary', 'x'],
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Invalid --level/);

    r = runScript(root, SCRIPT, { args: ['--pkg', '@fix/studio'] }); // no summary, no stdin pipe content
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/non-empty --summary/);

    const before = new Set(readdirSync(join(root, '.changeset')));
    r = runScript(root, SCRIPT, {
      args: ['--empty', '--summary', 'tooling only — no release'],
    });
    expect(r.status, r.stderr).toBe(0);
    let [file] = newChangesets(root, before);
    expect(readFileSync(join(root, '.changeset', file), 'utf8')).toMatch(
      /^---\n+---\n+tooling only/,
    );

    const before2 = new Set(readdirSync(join(root, '.changeset')));
    r = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio'],
      input: 'Summary via stdin.\n',
    });
    expect(r.status, r.stderr).toBe(0);
    [file] = newChangesets(root, before2);
    expect(readFileSync(join(root, '.changeset', file), 'utf8')).toMatch(
      /['"]@fix\/studio['"]: patch[\s\S]*Summary via stdin\./,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CW3: single-package repo — --pkg optional, defaults to the root package; config seeded', () => {
  const root = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', '--modules=changesets', root]).status).toBe(
      0,
    );
    expect(
      existsSync(join(root, '.changeset/config.json')),
      'config seeded for repo without one',
    ).toBeTruthy();
    linkChangesetsCli(root);
    const r = runScript(root, SCRIPT, {
      args: ['--summary', 'First release note.'],
    });
    expect(r.status, r.stderr).toBe(0);
    const file = r.stdout.trim();
    expect(readFileSync(join(root, file), 'utf8')).toMatch(
      /['"]single-app['"]: patch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CW4: refuses to author when @changesets/write is not resolvable — clear fix, no file', () => {
  // The fixture drives changesets from a root `pnpx` script with NO devDependency.
  // Authoring must hard-fail with install instructions, never hand-roll a file.
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const before = new Set(readdirSync(join(root, '.changeset')));

    const r = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio', '--summary', 'Should never be written.'],
    });
    expect(r.status, r.stdout).toBe(1);
    expect(r.stderr).toMatch(/@changesets\/write is not resolvable/);
    expect(r.stderr, 'actionable install command').toMatch(/pnpm add -D/);
    expect(
      newChangesets(root, before).length,
      'no changeset file may be created without the official writer',
    ).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
