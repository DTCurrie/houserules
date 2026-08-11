import { describe, expect, it } from 'vitest';

import { KitError } from '../plan.js';
import type { ModuleDef } from '@agent-kit/api';
import type {
  PluginSource,
  RegisteredModule,
  Registry,
} from '../plugin-registry.js';
import {
  assertNoRetiredModules,
  findRetired,
  resolveRecordedModuleIds,
  RETIRED_MODULES,
  retiredModuleAdvice,
} from '../retired-modules.js';

function stubModule(id: string): ModuleDef {
  return {
    id,
    title: id,
    group: 'optional',
    hint: () => id,
    defaultEnabled: () => false,
    plan: () => [],
  };
}

function pluginSource(alias: string): PluginSource {
  return {
    name: `@agent-kit/plugin-${alias}`,
    alias,
    version: '0.0.0',
    dir: `/packages/plugin-${alias}`,
  };
}

function registryOf(modules: RegisteredModule[]): Registry {
  return {
    modules,
    plugins: [],
    get: (id) => modules.find((m) => m.id === id),
  };
}

function registryWith(ids: string[]): Registry {
  return registryOf(
    ids.map((id) => ({ id, def: stubModule(id), source: null })),
  );
}

function registryWithPluginModule(
  alias: string,
  bareId: string,
  builtIns: string[] = ['core'],
): Registry {
  return registryOf([
    ...builtIns.map((id) => ({ id, def: stubModule(id), source: null })),
    {
      id: `${alias}/${bareId}`,
      def: stubModule(bareId),
      source: pluginSource(alias),
    },
  ]);
}

describe('findRetired', () => {
  it('reports a retired id the registry cannot supply', () => {
    expect(findRetired(['backlog'], registryWith(['core']))).toEqual([
      { id: 'backlog', packageName: '@agent-kit/plugin-backlog' },
    ]);
  });

  it('reports nothing for a module that was never retired', () => {
    expect(findRetired(['core', 'lint-fix'], registryWith(['core']))).toEqual(
      [],
    );
  });

  it('reports nothing once the plugin supplying that id is installed', () => {
    expect(
      findRetired(['backlog'], registryWithPluginModule('backlog', 'backlog')),
    ).toEqual([]);
  });

  it('reports nothing when the plugin alias differs from the module id', () => {
    expect(
      findRetired(['changesets'], registryWithPluginModule('cs', 'changesets')),
    ).toEqual([]);
  });

  it('reports nothing for an id that was renamed before it moved into a plugin', () => {
    expect(
      findRetired(
        ['terse-style'],
        registryWithPluginModule('prose', 'output-prose'),
      ),
    ).toEqual([]);
  });

  it('reports each retired id once even when named repeatedly', () => {
    const retired = findRetired(['backlog', 'backlog'], registryWith(['core']));

    expect(retired).toHaveLength(1);
  });
});

describe('retiredModuleAdvice', () => {
  it('groups ids that came from the same package onto one line', () => {
    const advice = retiredModuleAdvice([
      { id: 'changesets', packageName: '@agent-kit/plugin-changesets' },
      { id: 'ledger', packageName: '@agent-kit/plugin-changesets' },
    ]);

    expect(advice.split('\n')).toHaveLength(1);
    expect(advice).toContain('changesets, ledger');
  });

  it('names the plugins array so the fix is copy-pasteable', () => {
    const advice = retiredModuleAdvice([
      { id: 'testing', packageName: '@agent-kit/plugin-testing' },
    ]);

    expect(advice).toContain('.claude/kit.config.json');
    expect(advice).toContain('"name": "@agent-kit/plugin-testing"');
  });
});

describe('assertNoRetiredModules', () => {
  it('throws KitError naming the package that restores the module', () => {
    expect(() =>
      assertNoRetiredModules(['backlog'], registryWith(['core'])),
    ).toThrow(/@agent-kit\/plugin-backlog/);
  });

  it('throws KitError rather than a bare Error, so the CLI reports it as a user problem', () => {
    expect(() =>
      assertNoRetiredModules(['decisions'], registryWith(['core'])),
    ).toThrow(KitError);
  });

  it('states that nothing was changed, since the risk is a silent prune', () => {
    expect(() =>
      assertNoRetiredModules(['prose-voice'], registryWith(['core'])),
    ).toThrow(/Nothing was changed/);
  });

  it('passes an install whose modules are all still available', () => {
    expect(() =>
      assertNoRetiredModules(['core', 'lint-fix'], registryWith(['core'])),
    ).not.toThrow();
  });

  it('passes a pre-split manifest once the plugin supplying the id is wired', () => {
    expect(() =>
      assertNoRetiredModules(
        ['core', 'backlog'],
        registryWithPluginModule('backlog', 'backlog'),
      ),
    ).not.toThrow();
  });
});

describe('resolveRecordedModuleIds', () => {
  it('rewrites a pre-split bare id to the namespaced id the registry answers to', () => {
    expect(
      resolveRecordedModuleIds(
        ['core', 'backlog'],
        registryWithPluginModule('backlog', 'backlog'),
      ),
    ).toEqual(['core', 'backlog/backlog']);
  });

  it('uses the alias the repo chose rather than the module id', () => {
    expect(
      resolveRecordedModuleIds(
        ['changesets'],
        registryWithPluginModule('cs', 'changesets'),
      ),
    ).toEqual(['cs/changesets']);
  });

  it('leaves an id the registry already answers to alone', () => {
    expect(
      resolveRecordedModuleIds(['core', 'lint-fix'], registryWith(['core'])),
    ).toEqual(['core', 'lint-fix']);
  });

  it('leaves a genuinely retired id bare, so the gate still reports it', () => {
    expect(
      resolveRecordedModuleIds(['backlog'], registryWith(['core'])),
    ).toEqual(['backlog']);
  });

  it('is idempotent, so a migrated manifest does not migrate again', () => {
    const registry = registryWithPluginModule('backlog', 'backlog');
    const once = resolveRecordedModuleIds(['backlog'], registry);

    expect(resolveRecordedModuleIds(once, registry)).toEqual(once);
  });

  it('resolves an id that was renamed and moved into a plugin in one reorganization', () => {
    expect(
      resolveRecordedModuleIds(
        ['terse-style'],
        registryWithPluginModule('prose', 'output-prose'),
      ),
    ).toEqual(['prose/output-prose']);
  });

  it('resolves a renamed id that stayed a built-in', () => {
    expect(
      resolveRecordedModuleIds(['terse-style'], registryWith(['output-prose'])),
    ).toEqual(['output-prose']);
  });

  it('throws rather than guess when two plugins supply the same id', () => {
    const registry = registryOf([
      { id: 'core', def: stubModule('core'), source: null },
      {
        id: 'a/backlog',
        def: stubModule('backlog'),
        source: pluginSource('a'),
      },
      {
        id: 'b/backlog',
        def: stubModule('backlog'),
        source: pluginSource('b'),
      },
    ]);

    expect(() => resolveRecordedModuleIds(['backlog'], registry)).toThrow(
      KitError,
    );
  });

  it('names both candidates when it refuses an ambiguous id', () => {
    const registry = registryOf([
      {
        id: 'a/backlog',
        def: stubModule('backlog'),
        source: pluginSource('a'),
      },
      {
        id: 'b/backlog',
        def: stubModule('backlog'),
        source: pluginSource('b'),
      },
    ]);

    expect(() => resolveRecordedModuleIds(['backlog'], registry)).toThrow(
      /a\/backlog.*b\/backlog/s,
    );
  });
});

describe('RETIRED_MODULES', () => {
  it('maps every retired id to a plugin package name', () => {
    const wrong = Object.entries(RETIRED_MODULES).filter(
      ([, pkg]) => !pkg.startsWith('@agent-kit/plugin-'),
    );

    expect(wrong).toEqual([]);
  });

  it('carries the pre-rename terse-style id, since an old manifest still records it', () => {
    expect(RETIRED_MODULES['terse-style']).toBe('@agent-kit/plugin-prose');
  });
});
