import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { runCli, runIn } from '#test/run';
import { useInstalledRepo } from '#test/repo';

const CACHE_WRITER = '.claude/scripts/version-check.mjs';

function git(root: string, ...args: string[]): string {
  return runIn(root, 'git', args);
}

describe('the version-check cache under payload.commit: true without the changesets plugin', () => {
  it('leaves git status clean after the cache writer runs', () => {
    const root = useInstalledRepo('non-js', {
      config: { payload: { commit: true } },
    });
    rmSync(join(root, '.claude/.gitignore'));
    const update = runCli(['update', root]);
    expect(update.status, update.stderr + update.stdout).toBe(0);
    git(root, 'add', '-A');
    git(
      root,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '-m',
      'init',
    );

    const written = spawnSync(
      process.execPath,
      [join(root, CACHE_WRITER), root, '@houserules/cli'],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          npm_config_registry: 'http://127.0.0.1:1',
        },
        encoding: 'utf8',
      },
    );
    expect(written.status, written.stderr).toBe(0);

    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe(
      '',
    );
  });
});
