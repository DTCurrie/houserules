import { afterEach, describe, expect, it } from 'vitest';
import {
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

import { TargetRepo } from '../fs-target.js';

describe('TargetRepo.write, given a destination that is a symlink', () => {
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
