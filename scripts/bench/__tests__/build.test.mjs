import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  BUILD_STEPS,
  defaultCacheDir,
  ensureBuild,
  findBuild,
} from '../build.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'bench-build-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function fixture(name) {
  const dir = join(tmp, name);
  const repoDir = join(dir, 'repo');
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, 'init', '-q');
  git(repoDir, 'config', 'user.name', 'Test');
  git(repoDir, 'config', 'user.email', 'test@example.com');
  git(repoDir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repoDir, 'a.txt'), 'a\n');
  git(repoDir, 'add', '.');
  git(repoDir, 'commit', '-q', '-m', 'one');
  const counter = join(dir, 'counter.txt');
  const script = `const fs=require('fs');fs.writeFileSync('built.txt','ok');fs.appendFileSync(${JSON.stringify(counter)},'x\\n')`;
  return {
    repoDir,
    cacheDir: join(dir, 'cache'),
    counter,
    steps: [[process.execPath, ['-e', script]]],
  };
}

const worktrees = (repoDir) =>
  git(repoDir, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '));

describe('ensureBuild', () => {
  it('builds once, then reuses the cached build', () => {
    const { repoDir, cacheDir, counter, steps } = fixture('reuse');
    const sha = git(repoDir, 'rev-parse', 'HEAD').trim();
    const first = ensureBuild('HEAD', { repoDir, cacheDir, steps });
    assert.equal(first.cached, false);
    assert.equal(first.commit, sha);
    assert.equal(first.root, join(cacheDir, sha));
    assert.equal(readFileSync(join(first.root, 'built.txt'), 'utf8'), 'ok');
    assert.equal(worktrees(repoDir).length, 1);
    const count = readFileSync(counter, 'utf8');

    const second = ensureBuild('HEAD', { repoDir, cacheDir, steps });
    assert.equal(second.cached, true);
    assert.equal(second.root, first.root);
    assert.equal(readFileSync(counter, 'utf8'), count);
  });

  it('throws on a failing step and leaves nothing behind', () => {
    const { repoDir, cacheDir } = fixture('fail');
    const sha = git(repoDir, 'rev-parse', 'HEAD').trim();
    const steps = [[process.execPath, ['-e', 'process.exit(3)']]];
    assert.throws(
      () => ensureBuild('HEAD', { repoDir, cacheDir, steps }),
      /exit 3/,
    );
    assert.equal(worktrees(repoDir).length, 1);
    assert.equal(existsSync(join(cacheDir, sha)), false);
  });

  it('rebuilds a cache directory that lacks the completion marker', () => {
    const { repoDir, cacheDir, counter, steps } = fixture('partial');
    const sha = git(repoDir, 'rev-parse', 'HEAD').trim();
    mkdirSync(join(cacheDir, sha), { recursive: true });
    writeFileSync(join(cacheDir, sha, 'stale.txt'), 'x');
    const result = ensureBuild('HEAD', { repoDir, cacheDir, steps });
    assert.equal(result.cached, false);
    assert.equal(readFileSync(counter, 'utf8'), 'x\n');
    assert.equal(existsSync(join(result.root, 'stale.txt')), false);
    assert.equal(existsSync(join(result.root, 'built.txt')), true);
  });
});

describe('constants', () => {
  it('defaults', () => {
    assert.ok(defaultCacheDir().endsWith(join('houserules-bench', 'builds')));
    assert.deepEqual(
      BUILD_STEPS.map(([c, a]) => [c, ...a].join(' ')),
      ['pnpm install --frozen-lockfile', 'pnpm build'],
    );
  });
});

describe('findBuild', () => {
  const MARKER_FILE = '.bench-build.json';

  function assertUntouched(repoDir, cacheDir) {
    assert.equal(worktrees(repoDir).length, 1);
    assert.equal(existsSync(cacheDir) ? readdirSync(cacheDir).length : 0, 0);
  }

  it('returns null on an empty cache and adds nothing', () => {
    const { repoDir, cacheDir } = fixture('find-empty');
    assert.equal(findBuild('HEAD', { repoDir, cacheDir }), null);
    assertUntouched(repoDir, cacheDir);
  });

  it('returns null on a cache directory with no marker', () => {
    const { repoDir, cacheDir } = fixture('find-nomarker');
    const sha = git(repoDir, 'rev-parse', 'HEAD').trim();
    mkdirSync(join(cacheDir, sha), { recursive: true });
    assert.equal(findBuild('HEAD', { repoDir, cacheDir }), null);
    assert.equal(worktrees(repoDir).length, 1);
    assert.deepEqual(readdirSync(cacheDir), [sha]);
    assert.deepEqual(readdirSync(join(cacheDir, sha)), []);
  });

  it('returns the root once the marker exists', () => {
    const { repoDir, cacheDir } = fixture('find-marker');
    const sha = git(repoDir, 'rev-parse', 'HEAD').trim();
    mkdirSync(join(cacheDir, sha), { recursive: true });
    writeFileSync(join(cacheDir, sha, MARKER_FILE), '{}');
    assert.deepEqual(findBuild('HEAD', { repoDir, cacheDir }), {
      commit: sha,
      root: join(cacheDir, sha),
    });
    assert.equal(worktrees(repoDir).length, 1);
    assert.deepEqual(readdirSync(cacheDir), [sha]);
  });

  it('throws when rev names no commit', () => {
    const { repoDir, cacheDir } = fixture('find-badrev');
    assert.throws(() => findBuild('no-such-rev', { repoDir, cacheDir }));
  });
});
