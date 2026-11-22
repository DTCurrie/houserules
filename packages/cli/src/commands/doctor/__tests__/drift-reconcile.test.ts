import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
    const manifestPath = join(root, '.claude', 'houserules.manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.modules = ['backlog'];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    // init may record modules in the config too, and the config is read first.
    const configPath = join(root, '.claude', 'houserules.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (config.modules) {
      config.modules = ['backlog'];
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }

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
  const manifestPath = join(root, '.claude', 'houserules.manifest.json');
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

    const manifestPath = join(root, '.claude', 'houserules.manifest.json');
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

    const manifestPath = join(root, '.claude', 'houserules.manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.files[dest]).toBeUndefined();
  });
});

describe('reconcileDrift, given a manifest entry that is a dangling symlink', () => {
  it('reports it as orphaned, not as a stale manifest entry', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const manifestPath = join(root, '.claude', 'houserules.manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const dest = '.claude/scripts/dangling.mjs';
    manifest.files[dest] = 'deadbeef';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    mkdirSync(join(root, '.claude', 'scripts'), { recursive: true });
    symlinkSync(join(root, 'no-such-target.mjs'), join(root, dest));

    const found = messages(root);

    expect(found).toContainEqual(expect.stringContaining(`${dest}`));
    expect(found).not.toContainEqual(
      expect.stringContaining('manifest lists it but the file is gone'),
    );
  });
});

describe('reconcileDrift, given a config and a manifest that disagree on modules', () => {
  it('reads the config modules, so a retired module there is reported', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const configPath = join(root, '.claude', 'houserules.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.modules = ['backlog'];
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    expect(messages(root)).toEqual([
      expect.stringContaining(
        'install uses a module that moved into a plugin:',
      ),
    ]);
  });
});

const EJECTED_SKILL = '.claude/skills/ready/SKILL.md';

function ejectAndDisableReady(root: string): void {
  const manifestPath = join(root, '.claude', 'houserules.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const configPath = join(root, '.claude', 'houserules.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.modules = (manifest.modules as string[]).filter(
    (id) => id !== 'ready',
  );
  config.ejected = [EJECTED_SKILL];
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function reconcile(root: string, flags: Partial<Flags> = {}) {
  const ctx = detect(root);
  const { registry } = checkConfigValidity(root, ctx);
  if (!registry) throw new Error('unreachable: registry failed to build');
  return reconcileDrift(root, ctx, { ...FLAGS, ...flags }, registry);
}

describe('reconcileDrift, given an ejected file whose module is no longer enabled', () => {
  it('lists it in a readout as kept', () => {
    const root = useInstalledRepo('npm-single', { modules: 'ready' });
    ejectAndDisableReady(root);

    expect(reconcile(root).readouts).toContainEqual(
      expect.stringContaining(EJECTED_SKILL),
    );
  });

  it('raises no finding naming it, so no prune is offered', () => {
    const root = useInstalledRepo('npm-single', { modules: 'ready' });
    ejectAndDisableReady(root);

    expect(reconcile(root).findings.map((f) => f.msg)).not.toContainEqual(
      expect.stringContaining(EJECTED_SKILL),
    );
  });

  it('keeps the file under --fix --prune --force', () => {
    const root = useInstalledRepo('npm-single', { modules: 'ready' });
    ejectAndDisableReady(root);

    reconcile(root, { fix: true, prune: true, force: true });

    expect(
      existsSync(join(root, EJECTED_SKILL)),
      `${EJECTED_SKILL} still on disk`,
    ).toBe(true);
  });
});
