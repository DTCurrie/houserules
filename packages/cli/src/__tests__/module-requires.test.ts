import { describe, expect, it } from 'vitest';

import type { ModuleDef, ModuleRequirement } from '@houserules/api';
import { HouseError } from '../house-error.js';
import {
  assertNotWithdrawn,
  closeRequirements,
  requiredByNote,
  unmetRequirementMessage,
} from '../module-requires.js';
import type { RegisteredModule, Registry } from '../plugin-registry.js';

interface Spec {
  id: string;
  alias?: string;
  requires?: ModuleRequirement[];
  locked?: boolean;
  options?: ModuleDef['options'];
}

function registryOf(specs: Spec[]): Registry {
  const modules: RegisteredModule[] = specs.map((spec) => ({
    id: spec.alias ? `${spec.alias}/${spec.id}` : spec.id,
    source: spec.alias
      ? {
          name: `@houserules/plugin-${spec.alias}`,
          alias: spec.alias,
          version: '0.0.0',
          dir: `/packages/plugin-${spec.alias}`,
        }
      : null,
    def: {
      id: spec.id,
      title: spec.id,
      group: 'optional',
      hint: () => spec.id,
      defaultEnabled: () => false,
      plan: () => [],
      ...(spec.requires ? { requires: spec.requires } : {}),
      ...(spec.locked ? { locked: true } : {}),
      ...(spec.options ? { options: spec.options } : {}),
    } as ModuleDef,
  }));
  return {
    modules,
    plugins: [],
    get: (id) => modules.find((module) => module.id === id),
  };
}

const noOptions = { moduleOptions: () => ({}) };

describe('closeRequirements', () => {
  it('adds a directly required module', () => {
    const registry = registryOf([
      { id: 'a', requires: [{ id: 'b' }] },
      { id: 'b' },
    ]);
    expect(closeRequirements(registry, ['a'], noOptions)).toEqual({
      moduleIds: ['a', 'b'],
      requiredBy: { b: 'a' },
    });
  });

  it('follows a chain of requirements', () => {
    const registry = registryOf([
      { id: 'c' },
      { id: 'b', requires: [{ id: 'c' }] },
      { id: 'a', requires: [{ id: 'b' }] },
    ]);
    expect(closeRequirements(registry, ['a'], noOptions)).toEqual({
      moduleIds: ['c', 'b', 'a'],
      requiredBy: { b: 'a', c: 'b' },
    });
  });

  it('resolves a cycle once', () => {
    const registry = registryOf([
      { id: 'a', requires: [{ id: 'b' }] },
      { id: 'b', requires: [{ id: 'a' }] },
    ]);
    expect(closeRequirements(registry, ['a'], noOptions)).toEqual({
      moduleIds: ['a', 'b'],
      requiredBy: { b: 'a' },
    });
  });

  it('records nothing for a requirement already selected', () => {
    const registry = registryOf([
      { id: 'a', requires: [{ id: 'b' }] },
      { id: 'b' },
    ]);
    expect(closeRequirements(registry, ['b', 'a'], noOptions)).toEqual({
      moduleIds: ['a', 'b'],
      requiredBy: {},
    });
  });

  it('meets a requirement under an alias', () => {
    const registry = registryOf([
      { id: 'a', requires: [{ id: 'design' }] },
      { id: 'design', alias: 'ui' },
    ]);
    expect(closeRequirements(registry, ['a'], noOptions)).toEqual({
      moduleIds: ['a', 'ui/design'],
      requiredBy: { 'ui/design': 'a' },
    });
  });

  describe('option values', () => {
    const registry = registryOf([
      {
        id: 'a',
        options: {
          prompt: 'Pick',
          defaults: [],
          choices: [{ value: 'x', label: 'X', requires: [{ id: 'b' }] }],
        },
      },
      { id: 'b' },
    ]);

    it('pulls in the requirement of a selected value', () => {
      expect(
        closeRequirements(registry, ['a'], {
          moduleOptions: () => ({ a: ['x'] }),
        }),
      ).toEqual({ moduleIds: ['a', 'b'], requiredBy: { b: 'a' } });
    });

    it('pulls in nothing for the same value unselected', () => {
      expect(
        closeRequirements(registry, ['a'], {
          moduleOptions: () => ({ a: [] }),
        }),
      ).toEqual({ moduleIds: ['a'], requiredBy: {} });
    });
  });

  it('keeps a locked required module in and locked', () => {
    const registry = registryOf([
      { id: 'core', locked: true },
      { id: 'a', requires: [{ id: 'core' }] },
    ]);
    const closure = closeRequirements(registry, ['a'], noOptions);
    expect(closure).toEqual({
      moduleIds: ['core', 'a'],
      requiredBy: { core: 'a' },
    });
    expect(registry.get('core')?.def.locked).toBe(true);
  });

  it('keeps an id the registry does not know, after the registered ones', () => {
    const registry = registryOf([{ id: 'a' }]);
    expect(closeRequirements(registry, ['zzz', 'a'], noOptions)).toEqual({
      moduleIds: ['a', 'zzz'],
      requiredBy: {},
    });
  });

  it('errors naming both plugins when two supply it and neither is selected', () => {
    const registry = registryOf([
      { id: 'a', requires: [{ id: 'design' }] },
      { id: 'design', alias: 'one' },
      { id: 'design', alias: 'two' },
    ]);
    expect(() => closeRequirements(registry, ['a'], noOptions)).toThrow(
      new HouseError(
        'Module "a" requires "design", which is supplied by more than one plugin: one/design, two/design.\n' +
          'Nothing was changed. Select one of them, or remove one of those plugins from the "plugins" array in ' +
          '.claude/houserules.config.json.',
      ),
    );
  });

  it('prefers the selected plugin when two supply it', () => {
    const registry = registryOf([
      { id: 'a', requires: [{ id: 'design' }] },
      { id: 'design', alias: 'one' },
      { id: 'design', alias: 'two' },
    ]);
    expect(closeRequirements(registry, ['a', 'two/design'], noOptions)).toEqual(
      { moduleIds: ['a', 'two/design'], requiredBy: {} },
    );
  });

  it('throws the unmet message when nothing supplies the requirement', () => {
    const registry = registryOf([{ id: 'a', requires: [{ id: 'backlog' }] }]);
    expect(() => closeRequirements(registry, ['a'], noOptions)).toThrow(
      /which moved out of the CLI into a plugin/,
    );
  });
});

describe('unmetRequirementMessage', () => {
  it('names the retirement and package for a retired id', () => {
    expect(unmetRequirementMessage('a', { id: 'backlog' }, 'npm')).toBe(
      'Module "a" requires "backlog", which moved out of the CLI into a plugin:\n' +
        '  backlog moved to @houserules/plugin-backlog. Install it, then add { "name": "@houserules/plugin-backlog", "alias": "<alias>" } to the "plugins" array in .claude/houserules.config.json.\n' +
        'Nothing was changed.',
    );
  });

  it('prints the pnpm install command', () => {
    expect(
      unmetRequirementMessage('a', { id: 'x', package: '@scope/x' }, 'pnpm'),
    ).toBe(
      'Module "a" requires "x", which no installed plugin supplies.\n' +
        'Install it: pnpm add -D @scope/x\n' +
        'Then add { "name": "@scope/x", "alias": "<alias>" } to the "plugins" array in .claude/houserules.config.json.\n' +
        'Nothing was changed.',
    );
  });

  it('falls back to npm for an unknown package manager', () => {
    expect(
      unmetRequirementMessage('a', { id: 'x', package: '@scope/x' }, 'pip'),
    ).toBe(
      'Module "a" requires "x", which no installed plugin supplies.\n' +
        'Install it: npm install -D @scope/x\n' +
        'Then add { "name": "@scope/x", "alias": "<alias>" } to the "plugins" array in .claude/houserules.config.json.\n' +
        'Nothing was changed.',
    );
  });

  it('says the declaration names no package when it has none', () => {
    expect(unmetRequirementMessage('a', { id: 'x' }, 'npm')).toBe(
      'Module "a" requires "x", which no installed plugin supplies and whose declaration names no package.\nNothing was changed.',
    );
  });
});

describe('assertNotWithdrawn', () => {
  it('refuses to withdraw sweep while orchestrate requires it', () => {
    const closure = {
      moduleIds: ['sweep', 'orchestrate'],
      requiredBy: { sweep: 'orchestrate' },
    };
    expect(() => assertNotWithdrawn(closure, ['sweep'])).toThrow(
      new HouseError(
        'Cannot withdraw "sweep": "orchestrate" requires it. Withdraw "orchestrate" too, or keep "sweep".\nNothing was changed.',
      ),
    );
  });

  it('passes when the withdrawn id was not added by the closure', () => {
    expect(() =>
      assertNotWithdrawn({ moduleIds: ['a'], requiredBy: {} }, ['b']),
    ).not.toThrow();
  });
});

describe('requiredByNote', () => {
  it('lists each added module in moduleIds order', () => {
    expect(
      requiredByNote({
        moduleIds: ['b', 'a', 'c'],
        requiredBy: { c: 'a', b: 'a' },
      }),
    ).toBe(
      'Added because another module requires it:\n  b, required by a\n  c, required by a',
    );
  });

  it('is null when nothing was added', () => {
    expect(requiredByNote({ moduleIds: ['a'], requiredBy: {} })).toBeNull();
  });
});
