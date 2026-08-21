import { beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo, useRepo } from '#test/repo';
import { runCli, runScript } from '#test/run';
import { readJson, settingsOf } from '#test/installed-tree';

describe('statusline', () => {
  describe('when no statusLine is configured', () => {
    let root: string;
    let scriptOutput: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo', { modules: 'statusline' });
      appendFileSync(
        join(root, 'games/cityville/src/game.ts'),
        'export const q=1;\n',
      );
      const r = runScript(root, '.claude/scripts/statusline.mjs', {
        input: JSON.stringify({
          context_window: { used_percentage: 34 },
          cost: { total_cost_usd: 0.12 },
        }),
      });
      expect(r.status, r.stderr).toBe(0);
      scriptOutput = r.stdout;
    });

    it('sets statusLine to houserules command', () => {
      const settings = settingsOf(root);
      expect(settings.statusLine).toBeTruthy();
      expect(settings.statusLine.command).toMatch(/statusline\.mjs/);
    });

    it('installs the statusline script', () => {
      expect(
        existsSync(join(root, '.claude/scripts/statusline.mjs')),
      ).toBeTruthy();
    });

    it('passes doctor', () => {
      expect(runCli(['doctor', root]).status).toBe(0);
    });

    it.each([
      { detail: 'a [houserules] prefix', pattern: /\[houserules\]/ },
      { detail: 'the pending changeset count', pattern: /changeset/ },
      { detail: 'the touched target', pattern: /cityville/ },
      { detail: 'the ambient context percentage', pattern: /ctx 34%/ },
      { detail: 'the ambient cost', pattern: /\$0\.12/ },
    ])('includes $detail', ({ pattern }) => {
      expect(scriptOutput).toMatch(pattern);
    });
  });

  describe('when the user already defines a statusLine', () => {
    it('leaves the user’s statusLine untouched', () => {
      const root = useRepo('npm-single');
      const settingsPath = join(root, '.claude/settings.json');
      const settings = readJson(settingsPath);
      settings.statusLine = { type: 'command', command: 'my-own-statusline' };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

      expect(
        runCli(['init', '--yes', '--modules=statusline', root]).status,
      ).toBe(0);
      const after = readJson(settingsPath);
      expect(after.statusLine.command).toBe('my-own-statusline');
    });
  });
});
