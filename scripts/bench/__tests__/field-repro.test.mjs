import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'field-repro.mjs',
);
const SOURCE = readFileSync(SCRIPT, 'utf8');

const STUB_TOOL = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, JSON.stringify([process.argv[1].split('/').pop(), ...args]) + '\\n');
const location = args.find((a) => a.startsWith('--cache-location='));
if (args.includes('--cache') && !location) writeFileSync('.tool-cache', 'cache');
if (location) writeFileSync(location.slice('--cache-location='.length), 'cache');
if (args.includes('--fix') || args.includes('--write') || args.includes('-w'))
  writeFileSync('src/a.ts', 'rewritten\\n');
`;
const STUB_RUNNER = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_RUNNER_LOG"
while [ "$1" != "exec" ]; do shift; done
shift
exec "$@"
`;

const SCRIPTS = {
  'lint:fix': 'eslint . --fix',
  format: 'prettier --write .',
};

const EXECUTABLE_MODE = 0o755;

let work;
let counter = 0;

function runCommand(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function writeFile(root, file, text) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function installStubTools(bin) {
  mkdirSync(bin, { recursive: true });
  for (const [name, text] of [
    ['eslint', STUB_TOOL],
    ['prettier', STUB_TOOL],
    ['pnpm', STUB_RUNNER],
  ]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), EXECUTABLE_MODE);
  }
}

function fixtureConfig(runner) {
  return JSON.stringify({
    version: 2,
    packageManager: 'pnpm',
    fix: {
      runner,
      filterFlag: '',
      runScriptPrefix: ['run'],
      commands: ['lint:fix', 'format'],
    },
    targets: [
      {
        name: 'app',
        prefix: 'APP',
        packageName: 'app',
        pathPrefix: 'src/',
      },
    ],
  });
}

function makeFixture({ scripts = SCRIPTS, origin, runner = 'pnpm' } = {}) {
  counter += 1;
  const base = join(work, `case-${counter}`);
  const root = join(base, 'repo');
  const bin = join(base, 'bin');
  installStubTools(bin);
  mkdirSync(root, { recursive: true });
  runCommand(root, 'git', ['init', '-q']);
  if (origin) runCommand(root, 'git', ['remote', 'add', 'origin', origin]);
  writeFile(root, '.claude/houserules.config.json', fixtureConfig(runner));
  writeFile(root, 'package.json', JSON.stringify({ name: 'fx', scripts }));
  writeFile(root, '.gitignore', 'ignored.log\n');
  writeFile(root, 'ignored.log', 'ignored bytes\n');
  writeFile(root, 'src/a.ts', 'export const a = 1;\n');
  writeFile(root, 'other/b.ts', 'export const b = 1;\n');
  return {
    root,
    runnerLog: join(base, 'runner.log'),
    toolLog: join(base, 'tool.log'),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_LOG: join(base, 'tool.log'),
      STUB_RUNNER_LOG: join(base, 'runner.log'),
    },
  };
}

function reproduce(fixture, paths) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-', ...paths],
    {
      cwd: fixture.root,
      env: fixture.env,
      input: SOURCE,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    meta: lines.find((line) => line.kind === 'meta'),
    timings: lines.filter((line) => line.kind === 'timing'),
  };
}

function snapshot(dir, out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      snapshot(path, out);
      continue;
    }
    const stat = statSync(path);
    out.set(path, { bytes: readFileSync(path, 'utf8'), mtimeMs: stat.mtimeMs });
  }
  return out;
}

const calls = (log) =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];

describe('field-repro', () => {
  before(() => {
    work = realpathSync(mkdtempSync(join(tmpdir(), 'field-repro-')));
  });
  after(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('times each step once in check mode and leaves every fixture file untouched', async () => {
    const fixture = makeFixture();
    const before = snapshot(fixture.root);
    await new Promise((done) => setTimeout(done, 25));

    const { meta, timings } = reproduce(fixture, ['src/a.ts']);

    assert.deepEqual(snapshot(fixture.root), before);
    assert.ok(before.has(join(fixture.root, 'ignored.log')));
    assert.deepEqual(meta.commands, ['lint:fix', 'format']);
    assert.deepEqual(meta.paths, ['src/a.ts']);
    assert.deepEqual(
      timings.map((t) => [t.script, t.argv, t.status]),
      [
        [
          'lint:fix',
          [
            '--config.verify-deps-before-run=warn',
            'exec',
            'eslint',
            '.',
            '--fix-dry-run',
          ],
          0,
        ],
        [
          'format',
          [
            '--config.verify-deps-before-run=warn',
            'exec',
            'prettier',
            '--check',
            '.',
          ],
          0,
        ],
      ],
    );
    assert.deepEqual(
      calls(fixture.toolLog).map((line) => JSON.parse(line)),
      [
        ['eslint', '.', '--fix-dry-run'],
        ['prettier', '--check', '.'],
      ],
    );
    for (const t of timings) assert.equal(typeof t.durationMs, 'number');
  });

  it('shows the stubs would rewrite a file given the writing flag', () => {
    const fixture = makeFixture();
    const result = spawnSync('eslint', ['.', '--fix'], {
      cwd: fixture.root,
      env: fixture.env,
    });
    assert.equal(result.status, 0);
    assert.equal(
      readFileSync(join(fixture.root, 'src/a.ts'), 'utf8'),
      'rewritten\n',
    );
  });

  it('sends a --cache script its cache outside the fixture', () => {
    const fixture = makeFixture({
      scripts: {
        'lint:fix': 'eslint --cache . --fix',
        format: 'prettier --cache --cache-location .prettiercache --write .',
      },
    });
    const before = snapshot(fixture.root);

    const { timings } = reproduce(fixture, ['src/a.ts']);

    const tmp = realpathSync(tmpdir());
    for (const t of timings) {
      const location = t.argv.find((arg) =>
        arg.startsWith('--cache-location='),
      );
      assert.ok(location.slice('--cache-location='.length).startsWith(tmp));
      assert.ok(!location.includes(fixture.root));
      assert.equal(t.argv.filter((arg) => arg === '--cache').length, 1);
      assert.equal(
        t.argv.filter((arg) => arg.startsWith('--cache-location')).length,
        1,
      );
      assert.ok(existsSync(location.slice('--cache-location='.length)));
    }
    assert.deepEqual(snapshot(fixture.root), before);
    assert.ok(!existsSync(join(fixture.root, '.tool-cache')));
  });

  it('reports a script with no check form and never spawns it', () => {
    const fixture = makeFixture({
      scripts: {
        'lint:fix': 'eslint . --fix && prettier --write .',
        format: 'prettier --write .',
      },
    });

    const { timings } = reproduce(fixture, ['src/a.ts']);

    const byScript = Object.fromEntries(timings.map((t) => [t.script, t]));
    assert.equal(byScript['lint:fix'].argv, null);
    assert.equal(byScript['lint:fix'].durationMs, null);
    assert.equal(
      byScript['lint:fix'].scriptText,
      'eslint . --fix && prettier --write .',
    );
    assert.deepEqual(
      calls(fixture.toolLog).map((line) => JSON.parse(line)),
      [['prettier', '--check', '.']],
    );
    assert.equal(calls(fixture.runnerLog).length, 1);
  });

  it('marks a spawn that fails as an error with no duration', () => {
    const fixture = makeFixture({ runner: 'no-such-runner-command' });

    const { timings } = reproduce(fixture, ['src/a.ts']);

    assert.ok(timings.length > 0);
    for (const timing of timings) {
      assert.equal(timing.durationMs, null);
      assert.match(timing.error, /ENOENT/);
    }
  });

  it('writes error null and a numeric duration for a spawn that exits 0', () => {
    const fixture = makeFixture();

    const { timings } = reproduce(fixture, ['src/a.ts']);

    assert.ok(timings.length > 0);
    for (const timing of timings) {
      assert.equal(timing.error, null);
      assert.equal(typeof timing.durationMs, 'number');
    }
  });

  it('plans no step for a path under no target', () => {
    const fixture = makeFixture();

    const { meta, timings } = reproduce(fixture, [
      'other/b.ts',
      join(fixture.root, 'other/b.ts'),
    ]);

    assert.deepEqual(meta.paths, ['other/b.ts', 'other/b.ts']);
    assert.deepEqual(timings, []);
    assert.deepEqual(calls(fixture.runnerLog), []);
  });

  it('keys ssh and https remotes of one repository alike', () => {
    const ssh = reproduce(
      makeFixture({ origin: 'git@github.com:DTCurrie/houserules.git' }),
      ['src/a.ts'],
    );
    const https = reproduce(
      makeFixture({ origin: 'https://github.com/DTCurrie/houserules' }),
      ['src/a.ts'],
    );

    assert.equal(ssh.meta.remote, 'DTCurrie/houserules');
    assert.equal(https.meta.remote, 'DTCurrie/houserules');
    assert.deepEqual(
      [...ssh.timings, ...https.timings].map((t) => t.remote),
      Array(4).fill('DTCurrie/houserules'),
    );
  });
});
