import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';

import { makeCtx } from '#test/ctx-builder';
import type { HouseConfig } from '@houserules/api';
import type { HouseManifest } from '@houserules/api/internal';
import type { Ctx } from '../../../detect.js';
import { checkPluginRegistration } from '../plugin-registration.js';

const KIT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const ACCESSIBILITY = join(dirname(KIT_ROOT), 'plugin-accessibility');

/**
 * A synthetic dependency plugin shaped like a published one: its `exports` map declares `"."`
 * and nothing else, and its entry sits under `dist/`, so Node refuses to resolve
 * `@fake/plugin/package.json` through the bare specifier.
 */
function hostRootDependingOnFakePlugin(): { root: string; pluginDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'plugin-registration-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'host-repo',
      dependencies: { '@fake/plugin': '1.0.0' },
    }),
  );
  const pluginDir = join(root, 'node_modules', '@fake', 'plugin');
  mkdirSync(join(pluginDir, 'dist'), { recursive: true });
  writeFileSync(
    join(pluginDir, 'package.json'),
    JSON.stringify({
      name: '@fake/plugin',
      keywords: ['houserules-plugin'],
      main: './dist/index.js',
      exports: { '.': './dist/index.js' },
    }),
  );
  writeFileSync(join(pluginDir, 'dist', 'index.js'), 'module.exports = {};\n');
  return { root, pluginDir };
}

const MANIFEST: HouseManifest = {
  kitVersion: '1.0.0',
  installedAt: '2026-01-01T00:00:00.000Z',
  modules: ['core'],
  files: {},
};

function ctxWith(
  plugins: Array<{ name: string; alias: string }>,
  manifest: HouseManifest | null = MANIFEST,
): Ctx {
  const houseConfig = {
    version: 2,
    packageManager: 'pnpm',
    targets: [],
    plugins,
  } as unknown as HouseConfig;
  const base = makeCtx();
  return { ...base, claude: { ...base.claude, manifest, houseConfig } };
}

describe('checkPluginRegistration', () => {
  it('raises no warning for a plugin that merely sits beside the CLI', () => {
    expect(checkPluginRegistration('/repo', ctxWith([])).findings).toEqual([]);
  });

  it('names those plugins in a readout so they are still discoverable', () => {
    const { readouts } = checkPluginRegistration('/repo', ctxWith([]));

    expect(readouts.join('\n')).toContain('@houserules/plugin-accessibility');
  });

  it('reports every available plugin on one line rather than one line each', () => {
    const { readouts } = checkPluginRegistration('/repo', ctxWith([]));

    expect(readouts).toHaveLength(1);
  });

  it('drops a plugin from the readout once the config registers it by path', () => {
    const { readouts } = checkPluginRegistration(
      '/repo',
      ctxWith([{ name: ACCESSIBILITY, alias: 'a11y' }]),
    );

    expect(readouts.join('\n')).not.toContain('plugin-accessibility');
  });

  it('says nothing at all on a repo with no houserules installed', () => {
    expect(checkPluginRegistration('/repo', ctxWith([], null))).toEqual({
      findings: [],
      readouts: [],
    });
  });
});

describe('checkPluginRegistration, dependency-declared plugins', () => {
  it('warns when a dependency of the repo is not registered in houserules.config.json', () => {
    const { root } = hostRootDependingOnFakePlugin();

    const { findings } = checkPluginRegistration(root, ctxWith([]));

    expect(findings).toEqual([
      {
        level: 'WARN',
        msg: 'plugin @fake/plugin is a dependency of this repo but is not in houserules.config.json "plugins", so none of its modules are available',
      },
    ]);
  });

  it('does not warn once the dependency is registered in houserules.config.json', () => {
    const { root, pluginDir } = hostRootDependingOnFakePlugin();

    const { findings } = checkPluginRegistration(
      root,
      ctxWith([{ name: pluginDir, alias: 'fake' }]),
    );

    expect(findings).toEqual([]);
  });

  it('does not warn when the config registers the dependency by its package name', () => {
    const { root } = hostRootDependingOnFakePlugin();

    const { findings } = checkPluginRegistration(
      root,
      ctxWith([{ name: '@fake/plugin', alias: 'fake' }]),
    );

    expect(findings).toEqual([]);
  });
});
