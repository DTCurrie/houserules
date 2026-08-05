import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';
import { settingsOf } from '#test/installed-tree';

const PLUGIN_ACCESSIBILITY = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_ACCESSIBILITY, alias: 'a11y' }];

function installed(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'a11y/accessibility',
    plugins: PLUGINS,
  });
}

function wcag(root: string, ...args: string[]) {
  return runScript(root, '.claude/scripts/wcag.mjs', { args });
}

describe('wcag.mjs', () => {
  it('resolves a criterion by number, with its level and spec URL', () => {
    const root = installed();

    const result = wcag(root, 'lookup', '1.4.3');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1.4.3 Contrast (Minimum)');
    expect(result.stdout).toContain('Level AA');
    expect(result.stdout).toContain(
      'https://www.w3.org/TR/WCAG22/#contrast-minimum',
    );
  });

  it('exits 1 naming what to try when the criterion does not exist', () => {
    const root = installed();

    const result = wcag(root, 'lookup', '9.9.9');

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/patterns|keyword/i);
  });

  it('names the criteria a markup file is subject to', () => {
    const root = installed();
    writeFileSync(
      join(root, 'Comp.tsx'),
      '<div onClick={go}><img src="a.png" /></div>',
    );

    const result = wcag(root, 'applies', join(root, 'Comp.tsx'));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1.1.1');
    expect(result.stdout).toContain('2.1.1');
  });

  it('routes a suppressed focus outline to the focus-visibility criteria', () => {
    const root = installed();
    writeFileSync(
      join(root, 'Button.tsx'),
      '<button style={{ outline: "none" }}>Go</button>',
    );

    const result = wcag(root, 'applies', join(root, 'Button.tsx'));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('2.4.7');
  });

  it('exits 1 when no given file could be read', () => {
    const root = installed();

    const result = wcag(root, 'applies', join(root, 'absent.tsx'));

    expect(result.status).toBe(1);
  });

  it('prints the whole routing table', () => {
    const root = installed();

    const result = wcag(root, 'patterns');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('image-icon-or-svg');
    expect(result.stdout).toContain('suppressed-focus-indicator');
  });

  it('exits 1 with usage when given no subcommand', () => {
    const root = installed();

    const result = wcag(root);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/usage/i);
  });

  it('allowlists itself so the hook and the agent can run it unprompted', () => {
    const root = installed();

    const settings = settingsOf(root);

    expect(settings.permissions?.allow).toContain(
      'Bash(node .claude/scripts/wcag.mjs:*)',
    );
  });
});
