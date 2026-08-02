import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { settingsOf } from '#test/installed-tree';

describe('terse-style', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', {
      modules: 'terse-style',
    });
  });

  it('installs the terse output style with its MIT attribution', () => {
    const style = readFileSync(
      join(root, '.claude/output-styles/kit-terse.md'),
      'utf8',
    );
    expect(style).toMatch(/caveman/i);
    expect(style).toMatch(/MIT license/);
  });

  it('never activates the terse output style in settings.json', () => {
    const settings = settingsOf(root);
    expect(settings.outputStyle).toBe(undefined);
  });
});
