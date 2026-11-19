import { describe, expect, it } from 'vitest';

import { makeCtx } from '#test/ctx-builder';
import type { HouseManifest } from '@houserules/api/internal';
import type { ModuleDef } from '@houserules/api';
import type { Ctx } from '../../../detect.js';
import { MODULES } from '../../../plan.js';
import type { Registry } from '../../../plugin-registry.js';
import { checkModuleRequirements } from '../module-requirements.js';

function registryOf(defs: Array<{ id: string; def: ModuleDef }>): Registry {
  const modules = defs.map(({ id, def }) => ({ id, def, source: null }));
  return {
    modules,
    plugins: [],
    get: (id: string) => modules.find((entry) => entry.id === id),
  };
}

function ctxWith(
  modules: string[],
  moduleOptions?: Record<string, string[]>,
): Ctx {
  const manifest: HouseManifest = {
    kitVersion: '1.0.0',
    installedAt: '2026-01-01T00:00:00.000Z',
    modules,
    files: {},
  };
  const base = makeCtx();
  return {
    ...base,
    claude: {
      ...base.claude,
      manifest,
      houseConfig: moduleOptions
        ? ({ version: 2, moduleOptions } as Ctx['claude']['houseConfig'])
        : base.claude.houseConfig,
    },
  };
}

const BUILT_INS = registryOf(MODULES.map((def) => ({ id: def.id, def })));

function fixtureDef(overrides: Partial<ModuleDef>): ModuleDef {
  return {
    id: 'fixture',
    label: 'Fixture',
    hint: '',
    plan: () => [],
    ...overrides,
  } as ModuleDef;
}

describe('checkModuleRequirements', () => {
  it('warns when orchestrate is recorded without sweep', () => {
    const result = checkModuleRequirements(
      ctxWith(['core', 'orchestrate', 'plans']),
      BUILT_INS,
    );

    expect(result.findings).toEqual([
      {
        level: 'WARN',
        msg: '"orchestrate" requires "sweep", which is not installed. Run `npx houserules update` to install it.',
      },
    ]);
  });

  it('is quiet when sweep is recorded too', () => {
    const result = checkModuleRequirements(
      ctxWith(['core', 'orchestrate', 'plans', 'sweep']),
      BUILT_INS,
    );

    expect(result.findings).toEqual([]);
  });

  it('returns nothing without a registry or a manifest', () => {
    expect(
      checkModuleRequirements(ctxWith(['orchestrate']), null).findings,
    ).toEqual([]);
    const noManifest = makeCtx();
    noManifest.claude.manifest = null;
    expect(checkModuleRequirements(noManifest, BUILT_INS).findings).toEqual([]);
  });

  it('counts an alias-qualified module as meeting a bare requirement', () => {
    const registry = registryOf([
      {
        id: 'ui/needy',
        def: fixtureDef({ id: 'needy', requires: [{ id: 'design' }] }),
      },
      { id: 'ui/design', def: fixtureDef({ id: 'design' }) },
    ]);

    expect(
      checkModuleRequirements(ctxWith(['ui/needy', 'ui/design']), registry)
        .findings,
    ).toEqual([]);
  });

  it('names the package when no registered module supplies the requirement', () => {
    const registry = registryOf([
      {
        id: 'ui/needy',
        def: fixtureDef({
          id: 'needy',
          requires: [{ id: 'ghost', package: '@scope/plugin-ghost' }],
        }),
      },
    ]);

    expect(
      checkModuleRequirements(ctxWith(['ui/needy']), registry).findings,
    ).toEqual([
      {
        level: 'WARN',
        msg: '"ui/needy" requires "ghost", which no installed plugin supplies. Install @scope/plugin-ghost and add it to the "plugins" array in .claude/houserules.config.json.',
      },
    ]);
  });

  it('ends after "supplies." when the requirement names no package', () => {
    const registry = registryOf([
      {
        id: 'needy',
        def: fixtureDef({ id: 'needy', requires: [{ id: 'ghost' }] }),
      },
    ]);

    expect(
      checkModuleRequirements(ctxWith(['needy']), registry).findings,
    ).toEqual([
      {
        level: 'WARN',
        msg: '"needy" requires "ghost", which no installed plugin supplies.',
      },
    ]);
  });

  describe('an option value that requires a module', () => {
    const registry = registryOf([
      {
        id: 'needy',
        def: fixtureDef({
          id: 'needy',
          options: {
            prompt: 'Pick',
            choices: [
              { value: 'plain', label: 'Plain' },
              {
                value: 'fancy',
                label: 'Fancy',
                requires: [{ id: 'extra' }],
              },
            ],
            defaults: ['plain'],
          },
        } as Partial<ModuleDef>),
      },
      { id: 'extra', def: fixtureDef({ id: 'extra' }) },
    ]);

    it('warns when the value is selected', () => {
      expect(
        checkModuleRequirements(
          ctxWith(['needy'], { needy: ['fancy'] }),
          registry,
        ).findings,
      ).toEqual([
        {
          level: 'WARN',
          msg: '"needy" requires "extra", which is not installed. Run `npx houserules update` to install it.',
        },
      ]);
    });

    it('is quiet when the value is not selected', () => {
      expect(
        checkModuleRequirements(
          ctxWith(['needy'], { needy: ['plain'] }),
          registry,
        ).findings,
      ).toEqual([]);
    });
  });
});
