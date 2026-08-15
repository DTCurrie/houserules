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
    expect(manifest.modules.includes('design/chrome-devtools-mcp')).toBe(false);
    expect(existsSync(join(root, '.claude/mcp'))).toBe(false);
  });

  it('installs both configs and tracks them in the manifest when enabled', () => {
    const root = installedWith();

    expect(existsSync(stdioPath(root))).toBe(true);
    expect(existsSync(vscodePath(root))).toBe(true);

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('design/chrome-devtools-mcp')).toBe(true);
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

  it('installs the full stdio config with the expected command and args', () => {
    const root = installedWith();

    const config = JSON.parse(readFileSync(stdioPath(root), 'utf8'));

    expect(config.mcpServers['chrome-devtools'].command).toBe('npx');
    expect(config.mcpServers['chrome-devtools'].args).toEqual(FULL_ARGS);
  });
});
