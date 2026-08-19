import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createPayloadBuilders } from '../modules/copy-actions.js';
import type { Action } from '@houserules/api';
import type { PluginApi } from '../plugin.js';
import type { Plugin } from '../plugin.js';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_ROOT = join(KIT_ROOT, 'test/plugin-fixture');
const CLI_PAYLOAD_ROOT = join(KIT_ROOT, 'payload-dist');

// The fixture is a standalone package under test/, not a pnpm workspace member, so nothing
// links "@houserules/cli" into its node_modules. Link it here so the fixture resolves the
// same bare specifier a real plugin package would.
function ensureFixtureSelfLink(): void {
  const link = join(FIXTURE_ROOT, 'node_modules', '@houserules', 'cli');
  if (existsSync(link)) return;
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(KIT_ROOT, link, 'dir');
}

async function loadFixturePlugin(): Promise<Plugin> {
  ensureFixtureSelfLink();
  const mod: { default: Plugin } = await import(join(FIXTURE_ROOT, 'index.ts'));
  return mod.default;
}

function buildApi(config: unknown): PluginApi {
  return {
    payload: createPayloadBuilders(join(FIXTURE_ROOT, 'payload-dist')),
    packageName: '@houserules/plugin-fixture',
    alias: 'fixture',
    config,
  };
}

function planAllActions(api: PluginApi, plugin: Plugin): Action[] {
  const modules = plugin(api);
  return modules.flatMap((moduleDef) =>
    moduleDef.plan({ cwd: process.cwd() } as never, {
      moduleIds: [],
      targets: [],
      seedChangesetConfig: false,
      moduleOptions: {},
    }),
  );
}

describe('a plugin authored against @houserules/cli/plugin', () => {
  it('returns three modules', async () => {
    const plugin = await loadFixturePlugin();
    const modules = plugin(buildApi({ note: 'from config' }));

    expect(modules.length).toBe(3);
  });

  it('emits every action kind across its modules', async () => {
    const plugin = await loadFixturePlugin();
    const actions = planAllActions(buildApi({ note: 'from config' }), plugin);
    const kinds = new Set(actions.map((action) => action.kind));

    expect(kinds).toEqual(
      new Set([
        'copy',
        'write',
        'seed',
        'region',
        'body',
        'merge-settings',
        'advise',
      ]),
    );
  });

  it('resolves copy and body action src paths inside the fixture package, and those files exist', async () => {
    const plugin = await loadFixturePlugin();
    const actions = planAllActions(buildApi({}), plugin);
    const withSrc = actions.filter(
      (action): action is Action & { src: string } =>
        action.kind === 'copy' || action.kind === 'body',
    );

    expect(withSrc.length).toBeGreaterThan(0);
    for (const action of withSrc) {
      expect(action.src.startsWith(FIXTURE_ROOT)).toBe(true);
      expect(existsSync(action.src)).toBe(true);
    }
  });

  it("never points a src path into houserules' own payload-dist", async () => {
    const plugin = await loadFixturePlugin();
    const actions = planAllActions(buildApi({}), plugin);
    const withSrc = actions.filter(
      (action): action is Action & { src: string } =>
        action.kind === 'copy' || action.kind === 'body',
    );

    for (const action of withSrc) {
      expect(action.src.startsWith(CLI_PAYLOAD_ROOT)).toBe(false);
    }
  });

  it("passes api.config through to a module, observable in a write action's content", async () => {
    const plugin = await loadFixturePlugin();
    const actions = planAllActions(
      buildApi({ note: 'the configured note' }),
      plugin,
    );
    const seed = actions.find((action) => action.kind === 'seed');

    expect(seed?.content).toContain('the configured note');
  });

  it('passes api.alias through to a module, observable in an advise action', async () => {
    const plugin = await loadFixturePlugin();
    const api = { ...buildApi({}), alias: 'my-alias' };
    const actions = planAllActions(api, plugin);
    const advise = actions.find((action) => action.kind === 'advise');

    expect(advise?.text).toContain('my-alias');
  });
});
