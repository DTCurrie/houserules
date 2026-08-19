import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';

import {
  repoRoot,
  repoRootSafe,
} from '../../../../payload-dist/scripts/lib/config.mjs';

function inDirectory<TResult>(directory: string, run: () => TResult): TResult {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return run();
  } finally {
    process.chdir(previous);
  }
}

function outsideAnyWorkTree(): string {
  const directory = mkdtempSync(`${realpathSync(tmpdir())}/kit-no-git-`);
  execFileSync('git', ['init', '--bare', `${directory}/.decoy`], {
    stdio: 'ignore',
  });
  rmSync(`${directory}/.decoy`, { recursive: true, force: true });
  return directory;
}

describe('repoRootSafe', () => {
  it('returns the work tree root when there is one', () => {
    expect(repoRootSafe()).toBe(repoRoot());
  });

  it('returns null outside a work tree, where repoRoot throws', () => {
    const directory = outsideAnyWorkTree();

    try {
      inDirectory(directory, () => {
        expect(() => repoRoot()).toThrow();
        expect(repoRootSafe()).toBeNull();
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
