import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'diff-size.mts',
);

function diffSize(args: string[], cwd: string) {
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

function write(path: string, text: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const numbered = (count: number, prefix = 'line'): string =>
  Array.from({ length: count }, (_, n) => `${prefix} ${n}\n`).join('');

function repo(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'diff-size-'));
  git(dir, 'init', '-q');
  for (const [file, text] of Object.entries(files)) {
    write(join(dir, file), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const line = (lines: number, files: number, limits = '600 lines, 50 files') => {
  const [lineLimit, fileLimit] = limits.match(/\d+/g) ?? [];
  return `diff-size: ${lines} of ${lineLimit} lines, ${files} of ${fileLimit} files, within budget\n`;
};

describe('diff-size', () => {
  it('counts added plus deleted lines of an edit as one file', () => {
    const dir = repo({ 'a.txt': numbered(10) });
    write(join(dir, 'a.txt'), numbered(10).replace('line 3\n', 'x\ny\nz\n'));

    const result = diffSize(['--base', 'HEAD'], dir);

    expect(result).toEqual({ status: 0, stdout: line(4, 1), stderr: '' });
  });

  it('counts a staged edit and an unstaged edit together', () => {
    const dir = repo({ 'a.txt': numbered(10), 'b.txt': numbered(10) });
    write(join(dir, 'a.txt'), `${numbered(10)}extra\n`);
    git(dir, 'add', 'a.txt');
    write(join(dir, 'b.txt'), `${numbered(10)}extra\nmore\n`);

    const result = diffSize(['--base', 'HEAD'], dir);

    expect(result.stdout).toBe(line(3, 2));
  });

  it('counts a pure rename as 0 lines and 1 file', () => {
    const dir = repo({ 'a.txt': numbered(20) });
    git(dir, 'mv', 'a.txt', 'b.txt');

    const result = diffSize(['--base', 'HEAD'], dir);

    expect(result).toEqual({ status: 0, stdout: line(0, 1), stderr: '' });
  });

  it('counts a rename with edits as 1 file and only the edited lines', () => {
    const dir = repo({ 'a.txt': numbered(20) });
    git(dir, 'mv', 'a.txt', 'b.txt');
    write(join(dir, 'b.txt'), numbered(20).replace('line 5\n', 'changed\n'));

    const result = diffSize(['--base', 'HEAD'], dir);

    expect(result.stdout).toBe(line(2, 1));
  });

  it('counts a changed binary file as 1 file and 0 lines', () => {
    const dir = repo({ 'img.bin': Buffer.from([0, 1, 2, 3]) });
    write(join(dir, 'img.bin'), Buffer.from([0, 9, 9, 9, 9, 0]));

    const result = diffSize(['--base', 'HEAD'], dir);

    expect(result.stdout).toBe(line(0, 1));
  });

  it('counts an untracked file as its line count in additions and 1 file', () => {
    const dir = repo({ 'a.txt': numbered(3) });
    write(join(dir, 'new/n.txt'), 'one\ntwo\nthree last without newline');

    const result = diffSize(['--base', 'HEAD'], dir);

    expect(result.stdout).toBe(line(3, 1));
  });

  it('counts an untracked file with a NUL byte as 0 lines and 1 file', () => {
    const dir = repo({ 'a.txt': numbered(3) });
    write(join(dir, 'n.bin'), Buffer.from('a\nb\0c\n'));

    const result = diffSize(['--base', 'HEAD'], dir);

    expect(result.stdout).toBe(line(0, 1));
  });

  it('skips an untracked file that is gitignored', () => {
    const dir = repo({ '.gitignore': 'out/\n' });
    write(join(dir, 'out/o.txt'), numbered(40));

    const result = diffSize(['--base', 'HEAD'], dir);

    expect(result.stdout).toBe(line(0, 0));
  });

  it('counts a lock file like any other file', () => {
    const dir = repo({ 'pnpm-lock.yaml': numbered(5, 'old') });
    write(join(dir, 'pnpm-lock.yaml'), numbered(8, 'new'));

    const result = diffSize(['--base', 'HEAD'], dir);

    expect(result.stdout).toBe(line(13, 1));
  });

  it('counts from the repository root when run in a subdirectory', () => {
    const dir = repo({ 'sub/a.txt': numbered(3), 'top.txt': numbered(3) });
    write(join(dir, 'top.txt'), `${numbered(3)}x\n`);
    write(join(dir, 'top-new.txt'), 'y\n');

    const result = diffSize(['--base', 'HEAD'], join(dir, 'sub'));

    expect(result.stdout).toBe(line(2, 2));
  });

  it('diffs against a base ref other than HEAD', () => {
    const dir = repo({ 'a.txt': numbered(3) });
    write(join(dir, 'a.txt'), numbered(5));
    git(dir, 'commit', '-q', '-am', 'second');

    const result = diffSize(['--base', 'HEAD~1'], dir);

    expect(result.stdout).toBe(line(2, 1));
  });

  describe('limits', () => {
    it('exits 0 with the tree exactly at the line limit', () => {
      const dir = repo({ 'a.txt': '' });
      write(join(dir, 'a.txt'), numbered(5));

      const result = diffSize(['--base', 'HEAD', '--lines', '5'], dir);

      expect(result).toEqual({
        status: 0,
        stdout: line(5, 1, '5 lines, 50 files'),
        stderr: '',
      });
    });

    it('exits 1 with the tree one line past the line limit', () => {
      const dir = repo({ 'a.txt': '' });
      write(join(dir, 'a.txt'), numbered(6));

      const result = diffSize(['--base', 'HEAD', '--lines', '5'], dir);

      expect(result).toEqual({
        status: 1,
        stdout: 'diff-size: 6 of 5 lines, 1 of 50 files, over budget\n',
        stderr: '',
      });
    });

    it('exits 0 with the tree exactly at the file limit', () => {
      const dir = repo({ 'a.txt': 'a\n' });
      write(join(dir, 'n1.txt'), '');
      write(join(dir, 'n2.txt'), '');

      const result = diffSize(['--base', 'HEAD', '--files', '2'], dir);

      expect(result).toEqual({
        status: 0,
        stdout: line(0, 2, '600 lines, 2 files'),
        stderr: '',
      });
    });

    it('exits 1 with the tree one file past the file limit', () => {
      const dir = repo({ 'a.txt': 'a\n' });
      write(join(dir, 'n1.txt'), '');
      write(join(dir, 'n2.txt'), '');
      write(join(dir, 'n3.txt'), '');

      const result = diffSize(['--base', 'HEAD', '--files', '2'], dir);

      expect(result).toEqual({
        status: 1,
        stdout: 'diff-size: 0 of 600 lines, 3 of 2 files, over budget\n',
        stderr: '',
      });
    });

    it('exits 1 for pure renames past the file limit with 0 lines', () => {
      const dir = repo({
        'a1.txt': numbered(20, 'a'),
        'a2.txt': numbered(20, 'b'),
        'a3.txt': numbered(20, 'c'),
      });
      for (const name of ['a1', 'a2', 'a3']) {
        renameSync(join(dir, `${name}.txt`), join(dir, `${name}-moved.txt`));
      }
      git(dir, 'add', '-A');

      const result = diffSize(['--base', 'HEAD', '--files', '2'], dir);

      expect(result).toEqual({
        status: 1,
        stdout: 'diff-size: 0 of 600 lines, 3 of 2 files, over budget\n',
        stderr: '',
      });
    });
  });

  describe('exit 2', () => {
    it('reports a base that does not resolve, with empty stdout', () => {
      const dir = repo({ 'a.txt': 'a\n' });

      const result = diffSize(['--base', 'nope'], dir);

      expect(result).toEqual({
        status: 2,
        stdout: '',
        stderr: 'diff-size: base nope does not resolve\n',
      });
    });

    it('reports a run outside a git repository', () => {
      const dir = mkdtempSync(join(tmpdir(), 'diff-size-nogit-'));

      const result = diffSize(['--base', 'HEAD'], dir);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/inside a git repository/);
    });

    it.each([
      { name: 'a missing --base', args: [] },
      { name: 'a --base with no value', args: ['--base'] },
      { name: 'an unknown flag', args: ['--base', 'HEAD', '--nope'] },
      { name: 'a zero --lines', args: ['--base', 'HEAD', '--lines', '0'] },
      { name: 'a negative --files', args: ['--base', 'HEAD', '--files', '-3'] },
      {
        name: 'a fractional --lines',
        args: ['--base', 'HEAD', '--lines', '1.5'],
      },
      {
        name: 'a non-numeric --files',
        args: ['--base', 'HEAD', '--files', 'x'],
      },
    ])('exits 2 with usage for $name', ({ args }) => {
      const dir = repo({ 'a.txt': 'a\n' });

      const result = diffSize(args, dir);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/usage: diff-size\.mjs/);
    });
  });
});
