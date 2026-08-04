import { describe, expect, it } from 'vitest';

import { KitError } from '../plan.js';
import type { ModuleDef } from '../module-def.js';
import type { RegisteredModule, Registry } from '../plugin-registry.js';
import {
  assertNoRetiredModules,
  findRetired,
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

function registryWith(ids: string[]): Registry {
  const modules: RegisteredModule[] = ids.map((id) => ({
    id,
    def: stubModule(id),
    source: null,
  }));
  return {
    modules,
    plugins: [],
    get: (id) => modules.find((m) => m.id === id),
  };
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
    expect(findRetired(['backlog'], registryWith(['backlog']))).toEqual([]);
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
