import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ConfigTarget } from '@houserules/payload/config';
import { formatBranchLine, uncommittedLines } from '../session-context.mjs';
import { useInstalledRepo } from '#test/repo';
import { runIn, runScript, type RunResult } from '#test/run';

const SCRIPT = '.claude/scripts/session-context.mjs';
const KIT_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

describe('formatBranchLine', () => {
  it('reports a branch with no ahead/behind suffix when counts is empty', () => {
    expect(formatBranchLine('main', '')).toBe('[houserules] branch: main');
  });

  it('reports "(no commits yet)" when branch is undefined', () => {
    expect(formatBranchLine(undefined, '')).toBe(
      '[houserules] branch: (no commits yet)',
    );
  });

  it('appends "ahead N" when the branch is only ahead of upstream', () => {
    expect(formatBranchLine('main', '0\t3')).toBe(
      '[houserules] branch: main (ahead 3)',
    );
  });

  it('appends "behind N" when the branch is only behind upstream', () => {
    expect(formatBranchLine('main', '2\t0')).toBe(
      '[houserules] branch: main (behind 2)',
    );
  });

  it('appends both counts, ahead before behind, when the branch has diverged', () => {
    expect(formatBranchLine('main', '2\t3')).toBe(
      '[houserules] branch: main (ahead 3, behind 2)',
    );
  });
});

describe('uncommittedLines', () => {
  const targets: ConfigTarget[] = [
    { name: 'cityville', pathPrefix: 'games/cityville/' },
    { name: 'studio', pathPrefix: 'apps/studio/' },
  ];

  it('returns no lines for a clean tree', () => {
    expect(uncommittedLines([], targets)).toEqual([]);
  });

  it('lists the changed files inline and names the touched target', () => {
    expect(uncommittedLines(['games/cityville/src/game.ts'], targets)).toEqual([
      '[houserules] uncommitted (1): games/cityville/src/game.ts',
      '[houserules] targets touched: cityville',
    ]);
  });

  it('omits the targets line when no changed file maps to a configured target', () => {
    expect(uncommittedLines(['unmapped/file.ts'], targets)).toEqual([
      '[houserules] uncommitted (1): unmapped/file.ts',
    ]);
  });

  it('collapses to a per-target tally past the inline file threshold', () => {
    const changed = Array.from(
      { length: 26 },
      (_, i) => `games/cityville/src/file-${i}.ts`,
    );

    expect(uncommittedLines(changed, targets)).toEqual([
      '[houserules] uncommitted: 26 files — cityville (26)',
    ]);
  });

  it('trails the file list with an ellipsis when it exceeds the listed-file cap', () => {
    const changed = Array.from(
      { length: 11 },
      (_, i) => `games/cityville/src/file-${i}.ts`,
    );

    const [firstLine] = uncommittedLines(changed, targets);

    expect(firstLine).toMatch(/, …$/);
  });
});

describe('session-context.mjs', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'install houserules']);
  });

  it('prints only the branch line on a clean tree', () => {
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('[houserules] branch: main');
  });

  describe('with an uncommitted change', () => {
    let r: RunResult;

    beforeEach(() => {
      appendFileSync(join(root, 'games/cityville/src/game.ts'), '// tweak\n');
      r = runScript(root, SCRIPT, { input: '{}' });
    });

    it('exits 0 and keeps the header to at most 4 lines', () => {
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.split('\n').filter(Boolean).length).toBeLessThanOrEqual(
        4,
      );
    });
  });
});

describe('session-context.mjs on a repo with no commits yet', () => {
  it('exits 0 without crashing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-unborn-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    runIn(dir, 'git', ['init', '-q']);
    const r = spawnSync(
      process.execPath,
      [join(KIT_ROOT, 'payload-dist/scripts/session-context.mjs')],
      {
        cwd: dir,
        input: '{}',
        encoding: 'utf8',
      },
    );
    expect(r.status, r.stderr).toBe(0);
  });
});
