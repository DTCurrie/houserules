import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { manifestOf, readJson } from '#test/installed-tree';

const PLUGIN_TESTING = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_TESTING, alias: 'testing' }];

describe('playwright-mcp', () => {
  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo', { plugins: PLUGINS });

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('testing/playwright-mcp')).toBe(false);
    expect(existsSync(join(root, '.claude/mcp'))).toBe(false);
  });

  it('installs both configs under .claude/mcp/ and tracks them in the manifest when enabled', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'testing/playwright-mcp',
      plugins: PLUGINS,
    });

    expect(existsSync(join(root, '.claude/mcp/playwright.stdio.json'))).toBe(
      true,
    );
    expect(existsSync(join(root, '.claude/mcp/playwright.vscode.json'))).toBe(
      true,
    );

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('testing/playwright-mcp')).toBe(true);
    expect(
      Object.keys(manifest.files).filter((dest) =>
        dest.startsWith('.claude/mcp/playwright'),
      ),
    ).toEqual([
      '.claude/mcp/playwright.stdio.json',
      '.claude/mcp/playwright.vscode.json',
    ]);
  });

  it('ships the stdio config with npx and the pinned, capped, isolated, headless args', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'testing/playwright-mcp',
      plugins: PLUGINS,
    });

    const config = readJson<{
      mcpServers: { playwright: { command: string; args: string[] } };
    }>(join(root, '.claude/mcp/playwright.stdio.json'));

    expect(config.mcpServers.playwright.command).toBe('npx');
    expect(config.mcpServers.playwright.args).toEqual([
      '-y',
      '@playwright/mcp@0.0.79',
      '--headless',
      '--isolated',
      '--caps=testing',
    ]);
  });

  it('ships the vscode config under a servers key rather than mcpServers', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'testing/playwright-mcp',
      plugins: PLUGINS,
    });

    const raw = readFileSync(
      join(root, '.claude/mcp/playwright.vscode.json'),
      'utf8',
    );
    const config = JSON.parse(raw);

    expect(Object.keys(config)).toEqual(['servers']);
    expect(config.servers.playwright.command).toBe('npx');
    expect(config.servers.playwright.args).toEqual([
      '-y',
      '@playwright/mcp@0.0.79',
      '--headless',
      '--isolated',
      '--caps=testing',
    ]);
  });
});
