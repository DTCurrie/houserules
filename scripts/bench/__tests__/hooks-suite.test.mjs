import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ensureNewestBuild } from '../build.mjs';
import { cases, hookCaseEnv, scopeCases } from '../suites/hooks.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD = ensureNewestBuild('HEAD', { repoDir: REPO });

const SCOPE_CASE_NAMES = [
  'stop-lint-format-fix-scope-off',
  'stop-lint-format-fix-scope-on',
  'stop-lint-format-fix-scope-on-dot',
];
const SCOPE_REFORMAT_CASE_NAMES = [
  'stop-lint-format-fix-scope-on',
  'stop-lint-format-fix-scope-on-dot',
];

const SETTINGS_SCRIPT_RE = /\.claude\/scripts\/([\w.-]+)\.mjs/;
const CLEAN_AND_EDITED_STOP_CASES = 2;

function kebabCase(event) {
  return event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function readBuildJson(...segments) {
  const path = join(BUILD.root, '.claude', ...segments);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function wiredScripts() {
  const settings = readBuildJson('settings.json');
  const wiring = readBuildJson('scripts', 'hook-wiring.json');
  return Object.entries(settings.hooks).flatMap(([event, groups]) =>
    groups
      .flatMap((group) => group.hooks)
      .flatMap((hook) => {
        const script = SETTINGS_SCRIPT_RE.exec(hook.command)[1];
        if (script !== 'hook-dispatch') return [{ event, script }];
        return wiring.events[event].map((entry) => ({
          event,
          script: entry.script.replace(/\.mjs$/, ''),
        }));
      }),
  );
}

describe('hookCaseEnv', () => {
  it('turns pnpm dependency verification off and points at the project', () => {
    const env = hookCaseEnv('/tmp/home', '/tmp/project');
    assert.equal(env.pnpm_config_verify_deps_before_run, 'false');
    assert.equal(env.CLAUDE_PROJECT_DIR, '/tmp/project');
  });
});

describe('hooks suite', () => {
  let workDir;
  let suite;
  let scopeSuite;

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'bench-hooks-test-'));
    const all = await cases({ root: BUILD.root, repoDir: REPO, workDir });
    suite = all.filter(
      (benchCase) => !SCOPE_CASE_NAMES.includes(benchCase.name),
    );
    scopeSuite = all.filter((benchCase) =>
      SCOPE_CASE_NAMES.includes(benchCase.name),
    );
  });

  after(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('appends the three scope cases after the hook cases of a build tree', () => {
    assert.deepEqual(
      scopeSuite.map((benchCase) => benchCase.name),
      SCOPE_CASE_NAMES,
    );
  });

  it('returns one case per wired script, and two per Stop script, plus one dispatcher case per dispatched event', () => {
    const wired = wiredScripts();
    const dispatcherCases = suite.filter((benchCase) =>
      benchCase.args[1].includes('/hook-dispatch'),
    );
    const dispatchedEvents = [
      ...new Set(
        Object.entries(readBuildJson('settings.json').hooks)
          .filter(([, groups]) =>
            groups.some((group) =>
              group.hooks.some((hook) =>
                hook.command.includes('hook-dispatch'),
              ),
            ),
          )
          .map(([event]) => event),
      ),
    ];
    const casesFor = (script) =>
      suite.filter(
        (benchCase) =>
          benchCase.args[1].includes(`/${script}`) &&
          !dispatcherCases.includes(benchCase),
      );

    const observed = wired.map(
      ({ event, script }) => `${event} ${script} x${casesFor(script).length}`,
    );

    assert.deepEqual(
      observed,
      wired.map(
        ({ event, script }) =>
          `${event} ${script} x${event === 'Stop' ? CLEAN_AND_EDITED_STOP_CASES : 1}`,
      ),
    );
    assert.equal(
      suite.length,
      observed.length +
        wired.filter(({ event }) => event === 'Stop').length +
        dispatcherCases.length,
    );
    assert.deepEqual(
      dispatcherCases.map((benchCase) => benchCase.name),
      dispatchedEvents.map((event) => `${kebabCase(event)}-hook-dispatch`),
    );
  });

  it('splits each Stop script into a clean-tree and a dirty-tree case', () => {
    const stopScripts = wiredScripts().filter(({ event }) => event === 'Stop');

    const states = stopScripts.map(({ script }) =>
      suite
        .filter((benchCase) => benchCase.args[1].includes(`/${script}`))
        .map((benchCase) => benchCase.name.split('-').pop()),
    );

    assert.notEqual(
      stopScripts.length,
      0,
      'the wiring lists no Stop script, so this test checks nothing',
    );
    assert.deepEqual(
      states,
      stopScripts.map(() => ['clean', 'dirty']),
    );
  });

  it('names every case uniquely in kebab-case and runs it under workDir', () => {
    const names = suite.map((benchCase) => benchCase.name);

    const misplaced = suite
      .filter(
        (benchCase) =>
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(benchCase.name) ||
          !benchCase.cwd.startsWith(workDir),
      )
      .map((benchCase) => `${benchCase.name} in ${benchCase.cwd}`);

    assert.equal(new Set(names).size, names.length, names.join(', '));
    assert.deepEqual(misplaced, []);
  });

  it('runs every case once to an expected exit status', (t) => {
    const failures = [];
    const outputs = new Map();
    for (const benchCase of suite) {
      benchCase.beforeEach?.();
      const startedAt = process.hrtime.bigint();
      const result = spawnSync(benchCase.command, benchCase.args, {
        cwd: benchCase.cwd,
        env: { ...process.env, ...benchCase.env },
        input: benchCase.stdin,
        encoding: 'utf8',
        timeout: benchCase.timeoutMs ?? 60_000,
      });
      const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const expectExit = benchCase.expectExit ?? [0];
      t.diagnostic(
        `${benchCase.name} exit=${result.status} expect=[${expectExit}] ${wallMs.toFixed(0)}ms`,
      );
      if (result.signal !== null || !expectExit.includes(result.status))
        failures.push(
          `${benchCase.name} exited ${result.status} (${result.signal}), expected [${expectExit}]: ${result.stderr}`,
        );
      outputs.set(benchCase.name, result);
    }

    assert.deepEqual(failures, []);
    assert.match(
      outputs.get('ledger-inject').stdout,
      /\[houserules backlog\] BENCH-a1b2c3/,
    );
    assert.match(
      outputs.get('session-context').stdout,
      /\[houserules\] branch: main/,
    );
  });
});

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function writeFileEnsuringDirectory(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function makeFakeBuild(dir, fixerSource) {
  const root = join(dir, 'build');
  writeFileEnsuringDirectory(
    join(root, '.gitignore'),
    'node_modules/\npayload-dist/\n.bench-build.json\n',
  );
  writeFileEnsuringDirectory(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fake',
      scripts: {
        'lint:fix': 'eslint . --fix',
        'format:fix': 'prettier --write .',
      },
    }),
  );
  writeFileEnsuringDirectory(
    join(root, 'packages/api/package.json'),
    '{"name":"@fake/api"}',
  );
  writeFileEnsuringDirectory(
    join(root, 'packages/api/src/index.ts'),
    'export const one = 1;\n',
  );
  writeFileEnsuringDirectory(
    join(root, 'packages/cli/payload-dist/scripts/lint-format-fix.mjs'),
    fixerSource,
  );
  writeFileEnsuringDirectory(join(root, 'node_modules/eslint/index.js'), '');
  writeFileEnsuringDirectory(join(root, 'node_modules/.bin/eslint'), '');
  writeFileEnsuringDirectory(
    join(root, 'packages/api/node_modules/dep/index.js'),
    '',
  );
  runGit(dir, ['init', '-q', '-b', 'main', root]);
  runGit(root, ['config', 'user.name', 'bench']);
  runGit(root, ['config', 'user.email', 'bench@example.invalid']);
  runGit(root, ['add', '-A']);
  runGit(root, [
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'fake build',
  ]);
  const commit = runGit(root, ['rev-parse', 'HEAD']).trim();
  writeFileEnsuringDirectory(
    join(root, '.bench-build.json'),
    JSON.stringify({ commit }),
  );
  const repoDir = join(dir, 'live');
  runGit(dir, ['clone', '-q', root, repoDir]);
  return { root, repoDir };
}

function runCase(benchCase) {
  benchCase.beforeEach();
  return spawnSync(benchCase.command, benchCase.args, {
    cwd: benchCase.cwd,
    env: { ...process.env, ...benchCase.env },
    input: benchCase.stdin,
    encoding: 'utf8',
    timeout: benchCase.timeoutMs,
  });
}

function changedPaths(cwd) {
  return runGit(cwd, ['status', '--porcelain', '--untracked-files=all'])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));
}

const DISPATCH_COMMAND =
  'exec node "$CLAUDE_PROJECT_DIR/.claude/scripts/hook-dispatch.mjs"';

function writeWiring(tree, scripts) {
  writeFileEnsuringDirectory(
    join(tree, '.claude/settings.json'),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: DISPATCH_COMMAND }] },
        ],
      },
    }),
  );
  writeFileEnsuringDirectory(
    join(tree, '.claude/scripts/hook-wiring.json'),
    JSON.stringify({
      version: 1,
      events: { UserPromptSubmit: scripts.map((script) => ({ script })) },
    }),
  );
}

describe('hook wiring source', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'bench-wiring-test-'));
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('takes the wiring from the build tree, so a script wired only in the live repo is not resolved', async () => {
    const fake = makeFakeBuild(dir, 'process.exit(0);\n');
    writeFileEnsuringDirectory(
      join(fake.root, 'packages/cli/payload-dist/scripts/bench-probe.mjs'),
      'process.exit(0);\n',
    );
    writeWiring(fake.root, ['bench-probe.mjs']);
    writeWiring(fake.repoDir, ['bench-probe.mjs', 'notice-interim.mjs']);

    const suite = await cases({
      root: fake.root,
      repoDir: fake.repoDir,
      workDir: join(dir, 'work'),
    });

    assert.deepEqual(
      suite.map((benchCase) => benchCase.name),
      ['bench-probe', ...SCOPE_CASE_NAMES],
      'the live wiring names notice-interim.mjs, which the build lacks, so reading it fails with "expected one built notice-interim.mjs"',
    );
  });

  it('adds a dispatcher case ahead of its scripts when the build carries hook-dispatch', async () => {
    const buildDir = join(dir, 'dispatch-build');
    mkdirSync(buildDir);
    const fake = makeFakeBuild(buildDir, 'process.exit(0);\n');
    for (const script of ['bench-probe', 'hook-dispatch'])
      writeFileEnsuringDirectory(
        join(fake.root, `packages/cli/payload-dist/scripts/${script}.mjs`),
        'process.exit(0);\n',
      );
    writeWiring(fake.root, ['bench-probe.mjs']);

    const suite = await cases({
      root: fake.root,
      repoDir: fake.repoDir,
      workDir: join(dir, 'dispatch-work'),
    });

    assert.deepEqual(
      suite.map((benchCase) => benchCase.name),
      ['user-prompt-submit-hook-dispatch', 'bench-probe', ...SCOPE_CASE_NAMES],
    );
    assert.match(suite[0].args[1], /hook-dispatch\.mjs/);
  });

  it('throws naming the missing settings file when the build tree has none', async () => {
    const root = join(dir, 'bare-build');
    mkdirSync(root, { recursive: true });

    await assert.rejects(
      cases({ root, repoDir: REPO, workDir: join(dir, 'bare-work') }),
      /bare-build\/\.claude\/settings\.json is missing/,
    );
  });
});

describe('scope cases', () => {
  let dir;
  let fake;
  let suite;
  let armWorkDir;
  let armSuite;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'bench-scope-test-'));
    fake = makeFakeBuild(dir, 'process.exit(2);\n');
    suite = scopeCases({
      root: fake.root,
      repoDir: fake.repoDir,
      workDir: join(dir, 'work'),
    });
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (armWorkDir) rmSync(armWorkDir, { recursive: true, force: true });
  });

  const byName = (name) => suite.find((benchCase) => benchCase.name === name);
  const configOf = (benchCase) =>
    JSON.parse(
      readFileSync(
        join(benchCase.cwd, '.claude/houserules.config.json'),
        'utf8',
      ),
    );

  it('refuses to run against the live repository as its own build', () => {
    assert.throws(
      () => scopeCases({ root: REPO, repoDir: REPO, workDir: dir }),
      /scope cases need a build tree/,
    );
  });

  it('returns the off, on, and on-dot cases', () => {
    assert.deepEqual(
      suite.map((benchCase) => benchCase.name),
      SCOPE_CASE_NAMES,
    );
  });

  it('sets each arm to its fix commands and passPaths setting', () => {
    const observed = suite.map((benchCase) => {
      benchCase.beforeEach();
      const { commands, passPaths } = configOf(benchCase).fix;
      return [benchCase.name, commands, passPaths];
    });

    assert.deepEqual(observed, [
      ['stop-lint-format-fix-scope-off', ['lint:fix', 'format:fix'], false],
      [
        'stop-lint-format-fix-scope-on',
        ['lint:fix:paths', 'format:paths'],
        true,
      ],
      ['stop-lint-format-fix-scope-on-dot', ['lint:fix', 'format:fix'], true],
    ]);
  });

  it("defines each arm's scripts in the fixture package.json", () => {
    for (const benchCase of suite) {
      benchCase.beforeEach();
      const scripts = JSON.parse(
        readFileSync(join(benchCase.cwd, 'package.json'), 'utf8'),
      ).scripts;
      for (const command of configOf(benchCase).fix.commands)
        assert.ok(command in scripts, `${benchCase.name}: ${command}`);
    }
    assert.equal(
      JSON.parse(readFileSync(join(suite[0].cwd, 'package.json'), 'utf8'))
        .scripts['format:paths'],
      'prettier --cache --write',
    );
    assert.equal(
      JSON.parse(readFileSync(join(suite[0].cwd, 'package.json'), 'utf8'))
        .scripts['lint:fix:paths'],
      'eslint --fix',
    );
  });

  it('leaves exactly one changed .ts path, under a configured target', () => {
    for (const benchCase of suite) {
      benchCase.beforeEach();
      const changed = changedPaths(benchCase.cwd);
      assert.equal(changed.length, 1, `${benchCase.name}: ${changed}`);
      assert.match(changed[0], /\.ts$/);
      assert.ok(
        configOf(benchCase).targets.some((target) =>
          changed[0].startsWith(target.pathPrefix),
        ),
        `${benchCase.name}: ${changed[0]}`,
      );
    }
  });

  it('restores the repository before each run', () => {
    const benchCase = byName('stop-lint-format-fix-scope-off');
    benchCase.beforeEach();
    writeFileEnsuringDirectory(join(benchCase.cwd, 'stray.ts'), 'x');
    benchCase.beforeEach();

    assert.deepEqual(changedPaths(benchCase.cwd), [
      'packages/api/src/index.ts',
    ]);
  });

  it('makes the root node_modules a directory of links into the build', () => {
    const benchCase = suite[0];
    const modules = join(benchCase.cwd, 'node_modules');

    assert.ok(lstatSync(modules).isDirectory());
    assert.deepEqual(readdirSync(modules).sort(), ['.bin', 'eslint']);
    for (const entry of readdirSync(modules))
      assert.equal(
        realpathSync(join(modules, entry)),
        realpathSync(join(fake.root, 'node_modules', entry)),
      );
    assert.equal(
      realpathSync(join(benchCase.cwd, 'packages/api/node_modules')),
      realpathSync(join(fake.root, 'packages/api/node_modules')),
    );
  });

  it('leaves the build tree untouched, even when the fixer exits midway', () => {
    for (const benchCase of suite) {
      const result = runCase(benchCase);
      assert.equal(result.status, 2);
    }

    assert.equal(runGit(fake.root, ['status', '--porcelain']), '');
    assert.deepEqual(readdirSync(join(fake.root, 'node_modules')).sort(), [
      '.bin',
      'eslint',
    ]);
    assert.deepEqual(readdirSync(join(fake.root, 'node_modules/eslint')), [
      'index.js',
    ]);
  });

  const armCase = async (name) => {
    if (!armSuite) {
      armWorkDir = mkdtempSync(join(tmpdir(), 'bench-scope-arm-test-'));
      armSuite = await cases({
        root: BUILD.root,
        repoDir: REPO,
        workDir: armWorkDir,
      });
    }
    const benchCase = armSuite.find((candidate) => candidate.name === name);
    assert.ok(benchCase, `no case ${name}`);
    return benchCase;
  };

  it('stop-lint-format-fix-scope-off leaves the edit as written', async () => {
    const benchCase = await armCase('stop-lint-format-fix-scope-off');

    const result = runCase(benchCase);
    const [edited] = changedPaths(benchCase.cwd);
    const source = readFileSync(join(benchCase.cwd, edited), 'utf8');

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      source,
      /^export const {3}benchScope {2}= {2}1 ;$/m,
      'a Stop with fix.passPaths off runs no fix step, so the dirty edit survives',
    );
  });

  for (const name of SCOPE_REFORMAT_CASE_NAMES) {
    it(`${name} reformats the edit`, async () => {
      const benchCase = await armCase(name);

      const result = runCase(benchCase);
      const [edited] = changedPaths(benchCase.cwd);
      const source = readFileSync(join(benchCase.cwd, edited), 'utf8');

      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /lint-format-fix: skipped/);
      assert.match(source, /^export const benchScope = 1;$/m);
      assert.doesNotMatch(source, /benchScope {2}=/);
    });
  }
});
