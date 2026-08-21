import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, 'utf8')).toBe('payload body\nrouting tail\n');
  });

  it('keeps the link in place when the content already matches, so a re-run writes nothing', () => {
    const { repo, root } = linkedDest('payload body\n');

    const wrote = repo.write('rules/example.md', 'payload body\n');

    expect(wrote).toBe(false);
    expect(lstatSync(join(root, 'rules/example.md')).isSymbolicLink()).toBe(
      true,
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

    expect(existsSync(join(root, '.claude/backups'))).toBe(false);
  });
});
