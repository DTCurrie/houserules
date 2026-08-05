import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { makeCtx } from '#test/ctx-builder';
import type { KitConfig } from '../../../core/config.js';
import type { KitManifest } from '../../../core/manifest.js';
import type { Ctx } from '../../../detect.js';
import { checkPluginRegistration } from '../plugin-registration.js';

const KIT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const ACCESSIBILITY = join(dirname(KIT_ROOT), 'plugin-accessibility');

const MANIFEST: KitManifest = {
  kitVersion: '1.0.0',
  installedAt: '2026-01-01T00:00:00.000Z',
  modules: ['core'],
  files: {},
};

function ctxWith(
  plugins: Array<{ name: string; alias: string }>,
  manifest: KitManifest | null = MANIFEST,
): Ctx {
  const kitConfig = {
    version: 2,
    packageManager: 'pnpm',
    targets: [],
    plugins,
  } as unknown as KitConfig;
  const base = makeCtx();
  return { ...base, claude: { ...base.claude, manifest, kitConfig } };
}

describe('checkPluginRegistration', () => {
  it('raises no warning for a plugin that merely sits beside the CLI', () => {
    expect(checkPluginRegistration('/repo', ctxWith([])).findings).toEqual([]);
  });

  it('names those plugins in a readout so they are still discoverable', () => {
    const { readouts } = checkPluginRegistration('/repo', ctxWith([]));

    expect(readouts.join('\n')).toContain('@agent-kit/plugin-accessibility');
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

  it('says nothing at all on a repo with no kit installed', () => {
    expect(checkPluginRegistration('/repo', ctxWith([], null))).toEqual({
      findings: [],
      readouts: [],
    });
  });
});
