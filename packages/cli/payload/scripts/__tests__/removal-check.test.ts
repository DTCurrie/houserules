import { describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'removal-check.mts',
);

function removalCheck(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(result.stderr);
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const SHARED_BODY_LINES = 20;
const BODY = Array.from(
  { length: SHARED_BODY_LINES },
  (_, n) => `line ${n}`,
).join('\n');

function repo(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'removal-check-'));
  git(dir, 'init', '-q');
  for (const file of files) write(join(dir, file), `${BODY}\n// ${file}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('removal-check', () => {
  it('exits 0 with no output for a clean tree and no --allow flag', () => {
    const dir = repo(['a.txt']);

    const result = removalCheck([], dir);

    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it('exits 0 for a deleted file an --allow value names exactly', () => {
    const dir = repo(['a.txt', 'b.txt']);
    rmSync(join(dir, 'a.txt'));

    const result = removalCheck(['--allow', 'a.txt'], dir);

    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it('exits 0 for a deleted file under an allowed directory prefix', () => {
    const dir = repo(['old/deep/a.txt', 'keep.txt']);
    rmSync(join(dir, 'old/deep/a.txt'));

    const result = removalCheck(['--allow', 'old/'], dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exits 1 and prints a deletion no --allow value covers', () => {
    const dir = repo(['a.txt', 'b.txt']);
    rmSync(join(dir, 'a.txt'));
    rmSync(join(dir, 'b.txt'));

    const result = removalCheck(['--allow', 'b.txt'], dir);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('a.txt\n');
  });

  it('does not let a directory prefix without a slash cover a sibling name', () => {
    const dir = repo(['old/a.txt', 'older/b.txt']);
    rmSync(join(dir, 'older/b.txt'));

    const result = removalCheck(['--allow', 'old/'], dir);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('older/b.txt\n');
  });

  it('counts every deletion unnamed when no --allow flag is given', () => {
    const dir = repo(['a.txt']);
    rmSync(join(dir, 'a.txt'));

    const result = removalCheck([], dir);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('a.txt\n');
  });

  it('reports a staged deletion', () => {
    const dir = repo(['a.txt']);
    git(dir, 'rm', '-q', 'a.txt');

    const result = removalCheck([], dir);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('a.txt\n');
  });

  it('reports an unstaged deletion', () => {
    const dir = repo(['a.txt']);
    rmSync(join(dir, 'a.txt'));

    const result = removalCheck([], dir);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('a.txt\n');
  });

  it('does not report a pure rename as a deletion', () => {
    const dir = repo(['a.txt']);
    git(dir, 'mv', 'a.txt', 'renamed.txt');

    const result = removalCheck([], dir);

    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it('reports the old path of a rename git sees as a delete plus an untracked add', () => {
    const dir = repo(['a.txt']);
    renameSync(join(dir, 'a.txt'), join(dir, 'moved.txt'));
    write(join(dir, 'moved.txt'), 'something entirely different\n');

    const result = removalCheck([], dir);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('a.txt\n');
  });

  it('prints a path with spaces whole', () => {
    const dir = repo(['my docs/read me.txt']);
    rmSync(join(dir, 'my docs/read me.txt'));

    const result = removalCheck([], dir);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('my docs/read me.txt\n');
  });

  it('prints repo-root-relative paths when run from a subdirectory', () => {
    const dir = repo(['sub/a.txt', 'top.txt']);
    rmSync(join(dir, 'sub/a.txt'));
    rmSync(join(dir, 'top.txt'));

    const result = removalCheck(['--allow', 'top.txt'], join(dir, 'sub'));

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('sub/a.txt\n');
  });

  it('still reports an unnamed deletion when run through a symlink to the script', () => {
    const dir = repo(['a.txt']);
    rmSync(join(dir, 'a.txt'));
    const link = join(
      mkdtempSync(join(tmpdir(), 'removal-check-link-')),
      'rc.mts',
    );
    symlinkSync(SCRIPT, link);

    const result = spawnSync(process.execPath, [link], {
      cwd: dir,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('a.txt\n');
  });

  it('exits 2 with a message outside a git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'removal-check-nogit-'));

    const result = removalCheck([], dir);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/inside a git repository/);
  });

  it.each([
    { name: 'a trailing --allow with no value', args: ['--allow'] },
    { name: 'an unknown flag', args: ['--nope'] },
  ])('exits 2 with usage for $name', ({ args }) => {
    const dir = repo(['a.txt']);

    const result = removalCheck(args, dir);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: removal-check\.mjs/);
  });
});
