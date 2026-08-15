import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';
import {
  editHouseConfig,
  hookCommandsFor,
  settingsOf,
} from '#test/installed-tree';
import { readToolInput } from '#test/hook-input';

describe('regen-on-edit.mjs', () => {
  const REGEN = '.claude/scripts/regen-on-edit.mjs';
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', { modules: 'regen' });
  });

  it('installs the regen script and wires it into a PostToolUse hook', () => {
    expect(existsSync(join(root, REGEN))).toBeTruthy();
    const settings = settingsOf(root);
    expect(
      hookCommandsFor(settings, 'PostToolUse').some((c) =>
        c.includes('regen-on-edit.mjs'),
      ),
    ).toBeTruthy();
  });

  it('runs the target generator when an edited file matches its sourceGlob', () => {
    editHouseConfig(root, (c) => {
      const studio = c.targets.find((t: any) => t.name === 'studio');
      studio.regen = {
        sourceGlob: 'apps/studio/**',
        command: 'echo ran > regen-marker.txt',
      };
    });
    const r = runScript(
      root,
      REGEN,
      readToolInput({ file_path: 'apps/studio/src/main.ts' }),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'regen-marker.txt'))).toBeTruthy();
  });

  it('does not run the generator when the edited file does not match its sourceGlob', () => {
    editHouseConfig(root, (c) => {
      const studio = c.targets.find((t: any) => t.name === 'studio');
      studio.regen = {
        sourceGlob: 'apps/studio/**',
        command: 'echo ran > regen-marker.txt',
      };
    });
    const r = runScript(
      root,
      REGEN,
      readToolInput({ file_path: 'games/cityville/src/game.ts' }),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'regen-marker.txt'))).toBe(false);
  });

  it('exits 2 with a stderr tail of the failing generator’s output', () => {
    editHouseConfig(root, (c) => {
      const studio = c.targets.find((t: any) => t.name === 'studio');
      studio.regen = {
        sourceGlob: 'apps/studio/**',
        command: 'echo boom >&2; exit 1',
      };
    });
    const r = runScript(
      root,
      REGEN,
      readToolInput({ file_path: 'apps/studio/src/main.ts' }),
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/regen/);
    expect(r.stderr).toMatch(/boom/);
  });
});
