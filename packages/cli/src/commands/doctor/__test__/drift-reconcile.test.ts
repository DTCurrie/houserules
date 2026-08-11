import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Flags } from '../../../cli-contract.js';
import { detect } from '../../../detect.js';
import { useInstalledRepo } from '#test/repo';
import { checkConfigValidity } from '../config-validity.js';
import { reconcileDrift } from '../drift-reconcile.js';

const FLAGS: Flags = {
  dryRun: false,
  yes: true,
  modules: '',
  force: false,
  nextSteps: false,
  disable: '',
  reconfigure: '',
  fix: false,
  prune: false,
  json: false,
  kitVersion: '1.0.0',
};

function messages(root: string): string[] {
  const ctx = detect(root);
  const { registry } = checkConfigValidity(root, ctx);
  if (!registry) throw new Error('unreachable: registry failed to build');
  return reconcileDrift(root, ctx, FLAGS, registry).findings.map((f) => f.msg);
}

describe('reconcileDrift, given a manifest naming a retired built-in module', () => {
  it('reports the "moved into" ERROR finding rather than computing drift', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const manifestPath = join(root, '.claude', 'kit-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.modules = ['backlog'];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    expect(messages(root)).toEqual([
      expect.stringContaining(
        'install uses a module that moved into a plugin:',
      ),
    ]);
  });
});

describe('reconcileDrift, given a settings.json that fails to parse', () => {
  it('reports the "could not compute drift" ERROR finding', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    writeFileSync(join(root, '.claude', 'settings.json'), '{ not json');

    expect(messages(root)).toEqual([
      expect.stringContaining('could not compute drift: '),
    ]);
  });
});

function nameGoneFile(root: string): string {
  const manifestPath = join(root, '.claude', 'kit-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const dest = '.claude/scripts/already-deleted.mjs';
  manifest.files[dest] = 'deadbeef';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dest;
}

describe('reconcileDrift, given a manifest entry naming a file already gone from disk', () => {
  it('reports a stale-manifest-entry finding', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const dest = nameGoneFile(root);

    expect(messages(root)).toContainEqual(
      expect.stringContaining(
        `${dest}: manifest lists it but the file is gone from disk`,
      ),
    );
  });

  it('leaves the finding in place under --fix alone, since --prune also has to be set', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const dest = nameGoneFile(root);
    const ctx = detect(root);
    const { registry } = checkConfigValidity(root, ctx);
    if (!registry) throw new Error('unreachable: registry failed to build');

    reconcileDrift(root, ctx, { ...FLAGS, fix: true }, registry);

    const manifestPath = join(root, '.claude', 'kit-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.files[dest]).toBe('deadbeef');
  });

  it('drops the stale entry from the manifest under --fix --prune', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const dest = nameGoneFile(root);
    const ctx = detect(root);
    const { registry } = checkConfigValidity(root, ctx);
    if (!registry) throw new Error('unreachable: registry failed to build');

    reconcileDrift(root, ctx, { ...FLAGS, fix: true, prune: true }, registry);

    const manifestPath = join(root, '.claude', 'kit-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.files[dest]).toBeUndefined();
  });
});
