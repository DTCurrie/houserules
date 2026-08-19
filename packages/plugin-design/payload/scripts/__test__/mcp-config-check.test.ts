import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

const SCRIPT = '.claude/scripts/mcp-config-check.mjs';
const PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));

const FULL_ARGS = [
  '-y',
  'chrome-devtools-mcp@1.7.0',
  '--headless',
  '--isolated',
  '--no-usage-statistics',
];

function stage(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'design/chrome-devtools-mcp',
    plugins: [{ name: PLUGIN_DIR, alias: 'design' }],
  });
}

function writeFile(root: string, rel: string, body: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function writeMcpConfig(
  root: string,
  rel: string,
  args: string[],
  serverKey: 'mcpServers' | 'servers' = 'mcpServers',
) {
  writeFile(
    root,
    rel,
    JSON.stringify({
      [serverKey]: { 'chrome-devtools': { command: 'npx', args } },
    }),
  );
}

function run(root: string, files: string[]) {
  return runScript(root, SCRIPT, { args: files });
}

describe('mcp-config-check.mjs pinned version', () => {
  it('passes a config with the exact pinned version and all required flags', () => {
    const root = stage();
    writeMcpConfig(root, '.mcp.json', FULL_ARGS);

    const r = run(root, ['.mcp.json']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('design/mcp-config-pinned-version');
  });

  it('flags a config that dropped the pinned version arg entirely', () => {
    const root = stage();
    writeMcpConfig(root, '.mcp.json', [
      '-y',
      '--headless',
      '--isolated',
      '--no-usage-statistics',
    ]);

    const r = run(root, ['.mcp.json']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('design/mcp-config-pinned-version');
  });

  it('flags a config pinned to a moving tag instead of an exact version', () => {
    const root = stage();
    writeMcpConfig(root, '.mcp.json', [
      '-y',
      'chrome-devtools-mcp@latest',
      '--headless',
      '--isolated',
      '--no-usage-statistics',
    ]);

    const r = run(root, ['.mcp.json']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('design/mcp-config-pinned-version');
  });
});

describe('mcp-config-check.mjs required flags', () => {
  it('passes a slim config, since --slim is the only flag allowed to vary', () => {
    const root = stage();
    writeMcpConfig(root, '.mcp.json', [...FULL_ARGS, '--slim']);

    const r = run(root, ['.mcp.json']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('design/mcp-config-required-flags');
  });

  it('flags a config missing --headless', () => {
    const root = stage();
    writeMcpConfig(root, '.mcp.json', [
      '-y',
      'chrome-devtools-mcp@1.7.0',
      '--isolated',
      '--no-usage-statistics',
    ]);

    const r = run(root, ['.mcp.json']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('design/mcp-config-required-flags');
    expect(r.stdout).toContain('--headless');
  });
});

describe('mcp-config-check.mjs client agreement', () => {
  it('passes two wired-in clients whose args agree outside of --slim', () => {
    const root = stage();
    writeMcpConfig(root, '.mcp.json', FULL_ARGS);
    writeFile(
      root,
      '.vscode/mcp.json',
      JSON.stringify({
        servers: {
          'chrome-devtools': {
            command: 'npx',
            args: [...FULL_ARGS, '--slim'],
          },
        },
      }),
    );

    const r = run(root, ['.mcp.json', '.vscode/mcp.json']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('design/mcp-config-clients-agree');
  });

  it('flags two wired-in clients whose args disagree outside of --slim', () => {
    const root = stage();
    writeMcpConfig(root, '.mcp.json', FULL_ARGS);
    writeMcpConfig(
      root,
      '.vscode/mcp.json',
      [
        '-y',
        'chrome-devtools-mcp@1.7.0',
        '--isolated',
        '--no-usage-statistics',
      ],
      'servers',
    );

    const r = run(root, ['.mcp.json', '.vscode/mcp.json']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('design/mcp-config-clients-agree');
  });

  it('passes a single wired-in client, since there is nothing to disagree with', () => {
    const root = stage();
    writeMcpConfig(root, '.mcp.json', FULL_ARGS);

    const r = run(root, ['.mcp.json']);

    expect(r.stdout).not.toContain('design/mcp-config-clients-agree');
  });
});

describe('mcp-config-check.mjs, files with no chrome-devtools entry', () => {
  it('passes a config file with no chrome-devtools server at all', () => {
    const root = stage();
    writeFile(
      root,
      '.mcp.json',
      JSON.stringify({ mcpServers: { other: { command: 'npx', args: [] } } }),
    );

    const r = run(root, ['.mcp.json']);

    expect(r.status).toBe(0);
  });

  it('passes when the named file does not exist, since nothing was wired in', () => {
    const root = stage();

    const r = run(root, ['.mcp.json']);

    expect(r.status).toBe(0);
  });
});

describe('mcp-config-check.mjs declined scope', () => {
  it('always prints what it declines to check', () => {
    const root = stage();
    writeMcpConfig(root, '.mcp.json', FULL_ARGS);

    const r = run(root, ['.mcp.json']);

    expect(r.stdout).toContain('Not checked by this checker');
  });
});
