import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { useRepo } from '#test/repo';
import { runCli } from '#test/run';

describe('init and the version-check cache', () => {
  it('ignores the cache in the managed block when no changesets plugin is installed', () => {
    const root = useRepo('non-js');
    const result = runCli(['init', '--yes', root]);
    expect(result.status, result.stderr).toBe(0);

    const gitignore = readFileSync(join(root, '.claude/.gitignore'), 'utf8');
    expect(gitignore).toContain('/state/version-check.json');
    expect(gitignore).toContain('/state/hook-runs.jsonl');
    expect(gitignore).toContain('/state/hook-runs.1.jsonl');

    const check = spawnSync(
      'git',
      ['check-ignore', '-q', '.claude/state/version-check.json'],
      { cwd: root },
    );
    expect(check.status).toBe(0);

    const logCheck = spawnSync(
      'git',
      ['check-ignore', '-q', '.claude/state/hook-runs.jsonl'],
      { cwd: root },
    );
    expect(logCheck.status).toBe(0);

    const rotatedCheck = spawnSync(
      'git',
      ['check-ignore', '-q', '.claude/state/hook-runs.1.jsonl'],
      { cwd: root },
    );
    expect(rotatedCheck.status).toBe(0);
  });
});
