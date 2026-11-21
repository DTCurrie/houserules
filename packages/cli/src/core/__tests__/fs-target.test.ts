import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { TargetRepo, backupDestFor } from '../fs-target.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kit-fs-target-'));
  dirs.push(dir);
  return dir;
}

describe('TargetRepo.write, given a destination that is a symlink', () => {
  function linkedDest(linkBody: string): {
    repo: TargetRepo;
    root: string;
    source: string;
  } {
    const root = tempDir();
    const outside = tempDir();
    const source = join(outside, 'payload-rule.md');
    writeFileSync(source, linkBody);
    const dest = join(root, 'rules/example.md');
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(source, dest);
    return { repo: new TargetRepo(root, false), root, source };
  }

  it('leaves the bytes of the link target untouched when the content differs', () => {
    const { repo, source } = linkedDest('payload body\n');

    repo.write('rules/example.md', 'payload body\nrouting tail\n');

    expect(readFileSync(source, 'utf8')).toBe('payload body\n');
  });

  it('replaces the link with a real file holding the new content', () => {
    const { repo, root } = linkedDest('payload body\n');

    repo.write('rules/example.md', 'payload body\nrouting tail\n');

    const dest = join(root, 'rules/example.md');
    expect(
      lstatSync(dest).isSymbolicLink(),
      'link replaced with a real file',
    ).toBe(false);
    expect(readFileSync(dest, 'utf8')).toBe('payload body\nrouting tail\n');
  });

  it('keeps the link in place when the content already matches, so a re-run writes nothing', () => {
    const { repo, root } = linkedDest('payload body\n');

    const wrote = repo.write('rules/example.md', 'payload body\n');

    expect(wrote, 'no write when content already matches').toBe(false);
    expect(
      lstatSync(join(root, 'rules/example.md')).isSymbolicLink(),
      'link left in place',
    ).toBe(true);
  });
});

describe('TargetRepo.write, given a destination that already exists as a regular file', () => {
  function existingDest(mode: number): { repo: TargetRepo; root: string } {
    const root = tempDir();
    writeFileSync(join(root, 'manifest.json'), '{"old":true}\n');
    chmodSync(join(root, 'manifest.json'), mode);
    return { repo: new TargetRepo(root, false), root };
  }

  it('replaces the file by rename, so a reader holding the old file never sees new bytes land in it', () => {
    const { repo, root } = existingDest(0o644);
    linkSync(join(root, 'manifest.json'), join(root, 'reader-view.json'));

    repo.write('manifest.json', '{"new":true}\n');

    expect(
      readFileSync(join(root, 'reader-view.json'), 'utf8'),
      'an in-place write would have changed the bytes behind this hard link',
    ).toBe('{"old":true}\n');
    expect(readFileSync(join(root, 'manifest.json'), 'utf8')).toBe(
      '{"new":true}\n',
    );
  });

  it('leaves no temp file behind in the destination directory', () => {
    const { repo, root } = existingDest(0o644);

    repo.write('manifest.json', '{"new":true}\n');

    expect(readdirSync(root)).toEqual(['manifest.json']);
  });

  it('keeps the existing mode when the caller names none', () => {
    const { repo, root } = existingDest(0o755);

    repo.write('manifest.json', '{"new":true}\n');

    expect(
      (statSync(join(root, 'manifest.json')).mode & 0o777).toString(8),
    ).toBe('755');
  });

  it('applies the mode the caller names', () => {
    const { repo, root } = existingDest(0o644);

    repo.write('manifest.json', '{"new":true}\n', 0o755);

    expect(
      (statSync(join(root, 'manifest.json')).mode & 0o777).toString(8),
    ).toBe('755');
  });
});

describe('TargetRepo.exists and remove, given a dangling symlink', () => {
  it('sees the link as present, and remove unlinks it', () => {
    const root = tempDir();
    symlinkSync(join(root, 'no-target'), join(root, 'link.md'));
    const repo = new TargetRepo(root, false);

    expect(repo.exists('link.md')).toBe(true);
    repo.remove('link.md');

    expect(lstatSync(join(root, 'link.md'), { throwIfNoEntry: false })).toBe(
      undefined,
    );
  });
});

describe('backupDestFor', () => {
  it.each([
    {
      dest: '.claude/settings.json',
      backup: '.claude/backups/settings.json.bak',
    },
    {
      dest: '.claude/houserules.config.json',
      backup: '.claude/backups/houserules.config.json.bak',
    },
    {
      dest: '.claude/nested/settings.json',
      backup: '.claude/backups/nested__settings.json.bak',
    },
    { dest: 'CLAUDE.md', backup: '.claude/backups/CLAUDE.md.bak' },
  ])('maps $dest to $backup', ({ dest, backup }) => {
    expect(backupDestFor(dest)).toBe(backup);
  });
});

describe('TargetRepo.backupOnce', () => {
  function repoWithSettings(): { repo: TargetRepo; root: string } {
    const root = tempDir();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude/settings.json'), '{"user":true}\n');
    return { repo: new TargetRepo(root, false), root };
  }

  it('copies the file into .claude/backups/ alongside a self-gitignore', () => {
    const { repo, root } = repoWithSettings();

    repo.backupOnce('.claude/settings.json');

    expect(
      readFileSync(join(root, '.claude/backups/settings.json.bak'), 'utf8'),
    ).toBe('{"user":true}\n');
    expect(readFileSync(join(root, '.claude/backups/.gitignore'), 'utf8')).toBe(
      '*\n',
    );
  });

  it('never overwrites an existing backup', () => {
    const { repo, root } = repoWithSettings();
    repo.backupOnce('.claude/settings.json');
    writeFileSync(join(root, '.claude/settings.json'), '{"user":false}\n');

    repo.backupOnce('.claude/settings.json');

    expect(
      readFileSync(join(root, '.claude/backups/settings.json.bak'), 'utf8'),
    ).toBe('{"user":true}\n');
  });

  it('writes nothing on a dry run', () => {
    const { root } = repoWithSettings();
    const dry = new TargetRepo(root, true);

    dry.backupOnce('.claude/settings.json');

    expect(
      existsSync(join(root, '.claude/backups')),
      'no backup written on a dry run',
    ).toBe(false);
  });
});
