import { test } from 'node:test';
import assert from 'node:assert/strict';
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

import { makeFixture, runCli, runScript } from './fixtures.mjs';

const SCRIPT = '.claude/scripts/changeset-write.mjs';

function newChangesets(root, before) {
  return readdirSync(join(root, '.changeset')).filter(
    (f) => f.startsWith('kit-') && !before.has(f),
  );
}

test('CW1: writes a valid changeset for known packages', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
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
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout.trim(), /^\.changeset\/kit-[0-9a-f]{6}\.md$/);

    const [file] = newChangesets(root, before);
    const text = readFileSync(join(root, '.changeset', file), 'utf8');
    assert.match(
      text,
      /^---\n"@fix\/cityville": minor\n"@fix\/studio": patch\n---\n\nAdd road planning/,
      text,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CW2: validation — unknown package, bad level, --empty, stdin summary', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    let r = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/nope', '--summary', 'x'],
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown package "@fix\/nope"/);
    assert.match(
      r.stderr,
      /@fix\/cityville, @fix\/studio|@fix\/studio, @fix\/cityville/,
    );

    r = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio', '--level', 'huge', '--summary', 'x'],
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Invalid --level/);

    r = runScript(root, SCRIPT, { args: ['--pkg', '@fix/studio'] }); // no summary, no stdin pipe content
    assert.equal(r.status, 1);
    assert.match(r.stderr, /non-empty --summary/);

    const before = new Set(readdirSync(join(root, '.changeset')));
    r = runScript(root, SCRIPT, {
      args: ['--empty', '--summary', 'tooling only — no release'],
    });
    assert.equal(r.status, 0, r.stderr);
    let [file] = newChangesets(root, before);
    assert.match(
      readFileSync(join(root, '.changeset', file), 'utf8'),
      /^---\n---\n\ntooling only/,
    );

    const before2 = new Set(readdirSync(join(root, '.changeset')));
    r = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio'],
      input: 'Summary via stdin.\n',
    });
    assert.equal(r.status, 0, r.stderr);
    [file] = newChangesets(root, before2);
    assert.match(
      readFileSync(join(root, '.changeset', file), 'utf8'),
      /"@fix\/studio": patch[\s\S]*Summary via stdin\./,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CW3: single-package repo — --pkg optional, defaults to the root package; config seeded', () => {
  const root = makeFixture('npm-single');
  try {
    assert.equal(
      runCli(['init', '--yes', '--modules=changesets', root]).status,
      0,
    );
    assert.ok(
      existsSync(join(root, '.changeset/config.json')),
      'config seeded for repo without one',
    );
    const r = runScript(root, SCRIPT, {
      args: ['--summary', 'First release note.'],
    });
    assert.equal(r.status, 0, r.stderr);
    const file = r.stdout.trim();
    assert.match(readFileSync(join(root, file), 'utf8'), /"single-app": patch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CW4: authors via the repo-installed @changesets/write when present', () => {
  const root = makeFixture('npm-single');
  try {
    assert.equal(
      runCli(['init', '--yes', '--modules=changesets', root]).status,
      0,
    );
    // Make @changesets/cli resolvable from the fixture, as in a repo that has
    // changesets installed. @changesets/write resolves through it (pnpm-style
    // strict layouts don't hoist transitive deps).
    const cliDir = dirname(
      createRequire(import.meta.url).resolve('@changesets/cli/package.json'),
    );
    mkdirSync(join(root, 'node_modules/@changesets'), { recursive: true });
    symlinkSync(cliDir, join(root, 'node_modules/@changesets/cli'));

    const r = runScript(root, SCRIPT, {
      args: ['--pkg', 'single-app:minor', '--summary', 'Official writer.'],
    });
    assert.equal(r.status, 0, r.stderr);
    const file = r.stdout.trim();
    assert.match(
      file,
      /^\.changeset\/(?!kit-)[a-z][a-z-]*\.md$/,
      'human-id filename from @changesets/write, not the kit-<hex> fallback',
    );
    assert.match(
      readFileSync(join(root, file), 'utf8'),
      /^---\n['"]single-app['"]: minor\n---\n\nOfficial writer\./,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
