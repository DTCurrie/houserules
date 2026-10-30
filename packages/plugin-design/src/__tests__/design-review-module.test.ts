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

    const agentPath = join(root, '.claude/agents/design-reviewer.md');
    const skillPath = join(root, '.claude/skills/design-review/SKILL.md');

    expect(existsSync(agentPath), `${agentPath} exists`).toBe(true);
    expect(existsSync(skillPath), `${skillPath} exists`).toBe(true);
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

    const agentPath = join(root, '.claude/agents/design-reviewer.md');

    expect(manifest.modules).not.toContain('design/design-review');
    expect(existsSync(agentPath), `${agentPath} absent`).toBe(false);
  });

  it('names design.themeEntry in the installed skill and agent text', () => {
    const root = installed();

    const skillText = readFileSync(
      join(root, '.claude/skills/design-review/SKILL.md'),
      'utf8',
    );
    const agentText = readFileSync(
      join(root, '.claude/agents/design-reviewer.md'),
      'utf8',
    );

    expect(skillText).toMatch(/design\.themeEntry/);
    expect(agentText).toMatch(/design\.themeEntry/);
  });

  it('installs the generated defaults section and points the agent at it', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'design/design,design/design-review',
      plugins: PLUGINS,
    });

    const referenceText = readFileSync(
      join(root, '.claude/reference/design-visual-principles.md'),
      'utf8',
    );
    const agentText = readFileSync(
      join(root, '.claude/agents/design-reviewer.md'),
      'utf8',
    );

    expect(referenceText).toMatch(/^## Generated defaults$/m);
    expect(agentText).toMatch(/defaults/);
  });

  it('checks a drag handle for a hold timer', () => {
    const root = installed();

    const agentText = readFileSync(
      join(root, '.claude/agents/design-reviewer.md'),
      'utf8',
    );
    const checks = agentText.slice(
      agentText.indexOf('## What you check'),
      agentText.indexOf('## When to ask for a rendered check'),
    );

    expect(checks).toMatch(/hold timer/);
  });

  it('installs design-checks.mjs as a lib through the design module', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'design/design',
      plugins: PLUGINS,
    });
    const libPath = join(root, '.claude/scripts/lib/design-checks.mjs');

    expect(existsSync(libPath), `${libPath} exists`).toBe(true);
  });
});
