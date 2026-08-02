import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runIn, runScript, type RunResult } from '#test/run';

const SCRIPT = '.claude/scripts/session-context.mjs';
const KIT_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

describe('session-context.mjs', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'install kit']);
  });

  it('prints only the branch line on a clean tree', () => {
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\[kit\] branch: main/);
    expect(r.stdout.includes('uncommitted')).toBe(false);
  });

  describe('with an uncommitted change', () => {
    let r: RunResult;

    beforeEach(() => {
      appendFileSync(join(root, 'games/cityville/src/game.ts'), '// tweak\n');
      r = runScript(root, SCRIPT, { input: '{}' });
    });

    it('exits 0', () => {
      expect(r.status, r.stderr).toBe(0);
    });

    it('names the uncommitted file with its count', () => {
      expect(r.stdout).toMatch(
        /uncommitted \(1\): games\/cityville\/src\/game\.ts/,
      );
    });

    it('reports the target the change touched', () => {
      expect(r.stdout).toMatch(/targets touched: cityville/);
    });

    it('keeps the header to at most 4 lines', () => {
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
