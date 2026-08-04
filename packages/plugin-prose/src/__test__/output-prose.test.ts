import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { settingsOf } from '#test/installed-tree';

const PLUGIN_PROSE = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_PROSE, alias: 'prose' }];

describe('output-prose', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', {
      modules: 'prose/output-prose',
      plugins: PLUGINS,
    });
  });

  it('installs the prose output style under the frontmatter name Prose', () => {
    const style = readFileSync(
      join(root, '.claude/output-styles/output-prose.md'),
      'utf8',
    );
    expect(style).toMatch(/^---\nname: Prose\n/);
    expect(style).toMatch(/Token-lean responses/);
  });

  it('never activates the output style in settings.json', () => {
    const settings = settingsOf(root);
    expect(settings.outputStyle).toBe(undefined);
  });
});
