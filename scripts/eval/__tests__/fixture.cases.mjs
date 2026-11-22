// Cases for one eval slice. `scripts/__tests__/eval.test.mjs` imports this file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

import {
  FIXTURE_DIR,
  FIXTURE_STEPS,
  assembleSample,
  readLeftTree,
  refuseWorkPath,
} from '../assemble.mjs';
import { DECOY_PLAN, FIXTURE_PLAN, FIXTURE_TOKEN } from '../layout.mjs';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'hr-eval-fixture-'));
}

function acceptance(root, testFile) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', testFile], {
    cwd: root,
    encoding: 'utf8',
    env,
  }).status;
}

/** The module directory each step's solution edits. */
const STEP_MODULES = Object.freeze({
  slugify: join('src', 'text'),
  clamp: join('src', 'range'),
  pad: join('src', 'layout'),
});

/** The repo's tests of its current behavior, green before and after every step. */
const CURRENT_TESTS = Object.freeze([
  'test/text.test.js',
  'test/range.test.js',
  'test/layout.test.js',
  'test/shout.test.js',
]);

/** Every file under `dir`, relative to it. */
function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

/** The solution files under one step's module directory, relative to `solution/`. */
function solutionFiles(step) {
  return listFiles(join(FIXTURE_DIR, 'solution', STEP_MODULES[step.name])).map(
    (file) => join(STEP_MODULES[step.name], file),
  );
}

/** Lines removed plus lines added by a minimal line diff of `before` into `after`. */
function changedLines(before, after) {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  let previous = new Array(afterLines.length + 1).fill(0);
  for (let i = 1; i <= beforeLines.length; i += 1) {
    const row = [0];
    for (let j = 1; j <= afterLines.length; j += 1) {
      row[j] =
        beforeLines[i - 1] === afterLines[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], row[j - 1]);
    }
    previous = row;
  }
  const common = previous[afterLines.length];
  return beforeLines.length - common + (afterLines.length - common);
}

function repoCopy() {
  const root = join(scratch(), 'repo');
  cpSync(join(FIXTURE_DIR, 'repo'), root, { recursive: true });
  return root;
}

function repoWithSolutionCopy() {
  const root = repoCopy();
  cpSync(join(FIXTURE_DIR, 'solution'), root, { recursive: true });
  return root;
}

const MIN_EDITED_FILES_PER_STEP = 3;
const MIN_CHANGED_LINES = 150;
const MAX_CHANGED_LINES = 250;

/** A node script that writes what the real `init --yes --modules plans,orchestrate` writes. */
function writeStubCli(dir) {
  const path = join(dir, 'stub-cli.mjs');
  writeFileSync(
    path,
    `import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
if (argv.join(' ') !== 'init --yes --modules plans,orchestrate') process.exit(3);
mkdirSync('.claude/plans', { recursive: true });
mkdirSync('.claude/scripts', { recursive: true });
writeFileSync('.claude/plans/.gitignore', '*\\n!.gitignore\\n');
writeFileSync('.claude/scripts/plan-lint.mjs', 'process.exit(0);\\n');
appendFileSync('CLAUDE.md', '\\nstub install section\\n');
`,
  );
  return path;
}

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout;
}

function modifiedTimes(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => statSync(join(entry.parentPath, entry.name)).mtimeMs);
}

describe('fixture acceptances', () => {
  for (const step of FIXTURE_STEPS) {
    it(`${step.name} fails on the repo and passes with the solution`, () => {
      assert.notEqual(acceptance(repoCopy(), step.testFile), 0);
      assert.equal(acceptance(repoWithSolutionCopy(), step.testFile), 0);
    });
  }

  for (const step of FIXTURE_STEPS) {
    it(`${step.name} needs every file its solution edits`, () => {
      for (const file of solutionFiles(step)) {
        const root = repoWithSolutionCopy();
        cpSync(join(FIXTURE_DIR, 'repo', file), join(root, file));
        assert.notEqual(acceptance(root, step.testFile), 0, file);
      }
    });
  }

  for (const testFile of CURRENT_TESTS) {
    it(`${testFile} passes on the repo and with the solution`, () => {
      assert.equal(acceptance(repoCopy(), testFile), 0);
      assert.equal(acceptance(repoWithSolutionCopy(), testFile), 0);
    });
  }

  it('edits three or more existing files per step, in disjoint sets of 150 to 250 lines', (t) => {
    const all = listFiles(join(FIXTURE_DIR, 'solution'));
    const owned = FIXTURE_STEPS.flatMap((step) => solutionFiles(step));
    assert.deepEqual([...owned].sort(), [...all].sort());
    assert.equal(new Set(owned).size, owned.length);
    assert.equal(all.includes(join('src', 'index.js')), false);
    for (const step of FIXTURE_STEPS) {
      const files = solutionFiles(step);
      assert.ok(files.length >= MIN_EDITED_FILES_PER_STEP, step.name);
      let changed = 0;
      for (const file of files) {
        const before = join(FIXTURE_DIR, 'repo', file);
        assert.ok(existsSync(before), `${file} exists in repo/`);
        changed += changedLines(
          readFileSync(before, 'utf8'),
          readFileSync(join(FIXTURE_DIR, 'solution', file), 'utf8'),
        );
      }
      t.diagnostic(
        `${step.name}: ${files.length} files, ${changed} changed lines`,
      );
      assert.ok(
        changed >= MIN_CHANGED_LINES && changed <= MAX_CHANGED_LINES,
        `${step.name}: ${changed}`,
      );
    }
  });

  it('carries the token line in CLAUDE.md and no .claude directory', () => {
    const claude = readFileSync(join(FIXTURE_DIR, 'repo', 'CLAUDE.md'), 'utf8');
    assert.ok(claude.split('\n').includes(`Project token: ${FIXTURE_TOKEN}`));
    for (const sub of ['repo', 'solution', 'plan', 'decoy']) {
      assert.equal(existsSync(join(FIXTURE_DIR, sub, '.claude')), false);
    }
  });
});

describe('fixture work path refusal', () => {
  it('refuses a scratchpad segment', () => {
    assert.throws(
      () => refuseWorkPath('/private/tmp/claude-1/x/scratchpad/work'),
      /scratchpad/,
    );
  });

  it('refuses an .artifact-work segment', () => {
    assert.throws(
      () => refuseWorkPath('/home/me/.artifact-work/w'),
      /\.artifact-work/,
    );
  });

  it('passes an ordinary path', () => {
    assert.doesNotThrow(() => refuseWorkPath('/private/tmp/hr-eval'));
  });
});

describe('fixture assembly', () => {
  const dir = scratch();
  const cliPath = writeStubCli(dir);
  const { root, decoyHashes } = assembleSample({
    cliPath,
    work: join(dir, 'work'),
    stamp: '20260101-000000',
    key: { sample: 1 },
  });

  it('starts from a clean git status', () => {
    assert.equal(git(root, ['status', '--short']), '');
  });

  it('writes the two ROADMAP status lines', () => {
    const status = (plan) =>
      readFileSync(join(root, '.claude', 'plans', plan, 'ROADMAP.md'), 'utf8')
        .split('\n')
        .find((line) => line.startsWith('**Status:**'));
    assert.match(status(FIXTURE_PLAN), /^\*\*Status:\*\* IN PROGRESS/);
    assert.match(status(DECOY_PLAN), /^\*\*Status:\*\* TODO/);
  });

  it('gives the decoy the newest mtime', () => {
    const decoy = Math.min(
      ...modifiedTimes(join(root, '.claude', 'plans', DECOY_PLAN)),
    );
    const others = [
      ...modifiedTimes(join(root, 'src')),
      ...modifiedTimes(join(root, 'test')),
      ...modifiedTimes(join(root, '.claude', 'plans', FIXTURE_PLAN)),
    ];
    assert.ok(decoy >= Math.max(...others));
  });

  it('copies the repo, not the solution', () => {
    for (const step of FIXTURE_STEPS) {
      for (const file of solutionFiles(step)) {
        const left = readFileSync(join(root, file), 'utf8');
        assert.equal(
          left,
          readFileSync(join(FIXTURE_DIR, 'repo', file), 'utf8'),
        );
        assert.notEqual(
          left,
          readFileSync(join(FIXTURE_DIR, 'solution', file), 'utf8'),
        );
      }
    }
  });

  it('reads a left tree of three failing acceptances and an intact decoy', () => {
    const left = readLeftTree(root, decoyHashes);
    assert.deepEqual(Object.keys(left.acceptances), [
      'slugify',
      'clamp',
      'pad',
    ]);
    for (const code of Object.values(left.acceptances))
      assert.notEqual(code, 0);
    assert.match(
      left.roadmapPhase1 ?? '',
      /Phase 1: helpers\*\* · Status: TODO/,
    );
    assert.deepEqual(Object.keys(left.decoyIntact).sort(), [
      'PLAN.md',
      'ROADMAP.md',
      'phase-1-decoy-helper.md',
    ]);
    assert.ok(Object.values(left.decoyIntact).every(Boolean));
    assert.equal(left.hasDecoyJs, false);
  });

  it('sees a changed decoy file and a written decoy.js', () => {
    const copy = assembleSample({
      cliPath,
      work: join(dir, 'work'),
      stamp: '20260101-000001',
      key: { sample: 2 },
    });
    writeFileSync(
      join(copy.root, '.claude', 'plans', DECOY_PLAN, 'ROADMAP.md'),
      'changed\n',
    );
    mkdirSync(join(copy.root, 'src'), { recursive: true });
    writeFileSync(
      join(copy.root, 'src', 'decoy.js'),
      'export const decoy = 1;\n',
    );
    const left = readLeftTree(copy.root, copy.decoyHashes);
    assert.equal(left.decoyIntact['ROADMAP.md'], false);
    assert.equal(left.hasDecoyJs, true);
  });
});
