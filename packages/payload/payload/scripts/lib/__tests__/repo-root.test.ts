import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  repoRoot as configRepoRoot,
  repoRootSafe,
  requireRepoRoot,
} from '../config.mjs';
import { repoRoot as procRepoRoot } from '../proc.mjs';

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

describe('repoRoot outside a git work tree', () => {
  it('returns the same result from config.mts and proc.mts', () => {
    const directory = outsideAnyWorkTree();
    try {
      inDirectory(directory, () => {
        expect(configRepoRoot()).toBe(procRepoRoot());
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('falls back to the cwd instead of throwing, and repoRootSafe stays null', () => {
    const directory = outsideAnyWorkTree();
    try {
      inDirectory(directory, () => {
        expect(configRepoRoot()).toBe(process.cwd());
        expect(procRepoRoot()).toBe(process.cwd());
        expect(repoRootSafe()).toBeNull();
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requireRepoRoot refuses with an error naming the cwd', () => {
    const directory = outsideAnyWorkTree();
    try {
      inDirectory(directory, () => {
        expect(() => requireRepoRoot()).toThrow(
          `houserules: ${process.cwd()} is not inside a git work tree`,
        );
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
