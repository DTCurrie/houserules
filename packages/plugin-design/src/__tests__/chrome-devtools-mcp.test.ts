import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { manifestOf } from '#test/installed-tree';

const PLUGIN_DESIGN = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_DESIGN, alias: 'design' }];

const FULL_ARGS = [
  '-y',
  'chrome-devtools-mcp@1.7.0',
  '--headless',
  '--isolated',
  '--no-usage-statistics',
];

function stdioPath(root: string): string {
  return join(root, '.claude/mcp/chrome-devtools.stdio.json');
}

function vscodePath(root: string): string {
  return join(root, '.claude/mcp/chrome-devtools.vscode.json');
}

function installedWith(options?: string[]): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'design/chrome-devtools-mcp',
    plugins: PLUGINS,
    ...(options
      ? { moduleOptions: { 'design/chrome-devtools-mcp': options } }
      : {}),
  });
}

describe('chrome-devtools-mcp', () => {
  it('is not installed by default and creates no .claude/mcp/ directory', () => {
    const root = useInstalledRepo('pnpm-monorepo', { plugins: PLUGINS });

    const manifest = manifestOf(root);
    const mcpDir = join(root, '.claude/mcp');
    expect(manifest.modules).not.toContain('design/chrome-devtools-mcp');
    expect(existsSync(mcpDir), `${mcpDir} absent`).toBe(false);
  });

  it('installs both configs and tracks them in the manifest when enabled', () => {
    const root = installedWith();
    const stdio = stdioPath(root);
    const vscode = vscodePath(root);

    expect(existsSync(stdio), `${stdio} exists`).toBe(true);
    expect(existsSync(vscode), `${vscode} exists`).toBe(true);

    const manifest = manifestOf(root);
    expect(manifest.modules).toContain('design/chrome-devtools-mcp');
    expect(
      Object.keys(manifest.files).filter((dest) =>
        dest.startsWith('.claude/mcp/chrome-devtools.'),
      ),
    ).toEqual(
      expect.arrayContaining([
        '.claude/mcp/chrome-devtools.stdio.json',
        '.claude/mcp/chrome-devtools.vscode.json',
      ]),
    );
  });

  it('swaps in the slim args at the same dest when the slim option is chosen', () => {
    const full = readFileSync(stdioPath(installedWith()), 'utf8');
    const slim = readFileSync(stdioPath(installedWith(['slim'])), 'utf8');

    expect(full).not.toBe(slim);
    expect(JSON.parse(slim).mcpServers['chrome-devtools'].args).toEqual([
      ...FULL_ARGS,
      '--slim',
    ]);
  });

  it('installs the mode-switching skill and tracks it in the manifest', () => {
    const root = installedWith();
    const skillPath = join(
      root,
      '.claude/skills/chrome-devtools-mode/SKILL.md',
    );

    expect(existsSync(skillPath), `${skillPath} exists`).toBe(true);
    expect(Object.keys(manifestOf(root).files)).toContain(
      '.claude/skills/chrome-devtools-mode/SKILL.md',
    );
  });

  it('installs the mode-switching skill for the slim variant too', () => {
    const root = installedWith(['slim']);
    const skillPath = join(
      root,
      '.claude/skills/chrome-devtools-mode/SKILL.md',
    );

    expect(existsSync(skillPath), `${skillPath} exists`).toBe(true);
  });

  it('installs the mcp-config-check script and tracks it in the manifest', () => {
    const root = installedWith();
    const scriptPath = join(root, '.claude/scripts/mcp-config-check.mjs');

    expect(existsSync(scriptPath), `${scriptPath} exists`).toBe(true);
    expect(Object.keys(manifestOf(root).files)).toContain(
      '.claude/scripts/mcp-config-check.mjs',
    );
  });

  it('installs the full stdio config with the expected command and args', () => {
    const root = installedWith();

    const config = JSON.parse(readFileSync(stdioPath(root), 'utf8'));

    expect(config.mcpServers['chrome-devtools'].command).toBe('npx');
    expect(config.mcpServers['chrome-devtools'].args).toEqual(FULL_ARGS);
  });
});
