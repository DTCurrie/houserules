import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { manifestOf } from '#test/installed-tree';

const PLUGIN_DESIGN = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_DESIGN, alias: 'design' }];

function installed(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'design/design-review',
    plugins: PLUGINS,
  });
}

describe('design-review', () => {
  it('installs the design-reviewer agent and the design-review skill', () => {
    const root = installed();

    expect(existsSync(join(root, '.claude/agents/design-reviewer.md'))).toBe(
      true,
    );
    expect(
      existsSync(join(root, '.claude/skills/design-review/SKILL.md')),
    ).toBe(true);
  });

  it('declares the design-reviewer agent read-only, without Write or Edit', () => {
    const root = installed();

    const agentText = readFileSync(
      join(root, '.claude/agents/design-reviewer.md'),
      'utf8',
    );
    const toolsLine = agentText.match(/^tools:\s*(.+)$/m)?.[1] ?? '';
    const tools = toolsLine.split(',').map((tool) => tool.trim());

    expect(tools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
  });

  it("permits the design.mjs script in the skill's allowed-tools", () => {
    const root = installed();

    const skillText = readFileSync(
      join(root, '.claude/skills/design-review/SKILL.md'),
      'utf8',
    );

    expect(skillText).toMatch(/allowed-tools:.*design\.mjs/);
  });

  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo', { plugins: PLUGINS });

    const manifest = manifestOf(root);

    expect(manifest.modules.includes('design/design-review')).toBe(false);
    expect(existsSync(join(root, '.claude/agents/design-reviewer.md'))).toBe(
      false,
    );
  });

  it('installs design-checks.mjs as a lib through the design module', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'design/design',
      plugins: PLUGINS,
    });

    expect(
      existsSync(join(root, '.claude/scripts/lib/design-checks.mjs')),
    ).toBe(true);
  });
});
