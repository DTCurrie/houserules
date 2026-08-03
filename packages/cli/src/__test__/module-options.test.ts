import { describe, expect, it } from 'vitest';

import { KitError } from '../plan.js';
import {
  parseModuleOptionFlags,
  resolveModuleOptions,
} from '../module-options.js';
import type { ModuleDef } from '../module-def.js';
import type { RegisteredModule, Registry } from '../plugin-registry.js';

function moduleWithOptions(
  id: string,
  choices: string[],
  defaults: string[],
): ModuleDef {
  return {
    id,
    title: id,
    group: 'optional',
    hint: () => '',
    defaultEnabled: () => true,
    options: {
      prompt: 'pick one',
      choices: choices.map((value) => ({ value, label: value })),
      defaults,
    },
    plan: () => [],
  };
}

function registryOf(defs: ModuleDef[]): Registry {
  const modules: RegisteredModule[] = defs.map((def) => ({
    id: def.id,
    def,
    source: null,
  }));
  return {
    modules,
    plugins: [],
    get: (id) => modules.find((m) => m.id === id),
  };
}

describe('parseModuleOptionFlags', () => {
  it('parses a single id=values pair', () => {
    expect(parseModuleOptionFlags(['testing=typescript,javascript'])).toEqual({
      testing: ['typescript', 'javascript'],
    });
  });

  it('splits on the first = only, keeping a plugin-namespaced id intact', () => {
    expect(parseModuleOptionFlags(['voice/prose-voice=strict'])).toEqual({
      'voice/prose-voice': ['strict'],
    });
  });

  it('trims whitespace around the id and each value', () => {
    expect(
      parseModuleOptionFlags([' testing = typescript , javascript ']),
    ).toEqual({ testing: ['typescript', 'javascript'] });
  });

  it('drops empty entries from a trailing comma', () => {
    expect(parseModuleOptionFlags(['testing=typescript,'])).toEqual({
      testing: ['typescript'],
    });
  });

  it('merges multiple flags into one record', () => {
    expect(
      parseModuleOptionFlags([
        'testing=typescript',
        'voice/prose-voice=strict',
      ]),
    ).toEqual({ testing: ['typescript'], 'voice/prose-voice': ['strict'] });
  });

  it('throws when a value has no =', () => {
    expect(() => parseModuleOptionFlags(['testing'])).toThrow(KitError);
  });

  it('throws when the id is empty', () => {
    expect(() => parseModuleOptionFlags(['=typescript'])).toThrow(KitError);
  });

  it('throws when the value list is empty', () => {
    expect(() => parseModuleOptionFlags(['testing='])).toThrow(KitError);
  });

  it('throws when the value list is only a trailing comma', () => {
    expect(() => parseModuleOptionFlags(['testing=,'])).toThrow(KitError);
  });

  it('throws when an id repeats across two flags', () => {
    expect(() =>
      parseModuleOptionFlags(['testing=typescript', 'testing=javascript']),
    ).toThrow(KitError);
  });
});

describe('resolveModuleOptions', () => {
  it('falls back to defaults when nothing is persisted or overridden', () => {
    const registry = registryOf([
      moduleWithOptions(
        'testing',
        ['typescript', 'javascript'],
        ['typescript'],
      ),
    ]);
    expect(resolveModuleOptions(registry, ['testing'], undefined)).toEqual({
      testing: ['typescript'],
    });
  });

  it('prefers persisted over defaults', () => {
    const registry = registryOf([
      moduleWithOptions(
        'testing',
        ['typescript', 'javascript'],
        ['typescript'],
      ),
    ]);
    expect(
      resolveModuleOptions(registry, ['testing'], { testing: ['javascript'] }),
    ).toEqual({ testing: ['javascript'] });
  });

  it('prefers an override over persisted', () => {
    const registry = registryOf([
      moduleWithOptions(
        'testing',
        ['typescript', 'javascript'],
        ['typescript'],
      ),
    ]);
    expect(
      resolveModuleOptions(
        registry,
        ['testing'],
        { testing: ['javascript'] },
        { testing: ['typescript', 'javascript'] },
      ),
    ).toEqual({ testing: ['typescript', 'javascript'] });
  });

  it('drops a value absent from the module choices', () => {
    const registry = registryOf([
      moduleWithOptions(
        'testing',
        ['typescript', 'javascript'],
        ['typescript'],
      ),
    ]);
    expect(
      resolveModuleOptions(registry, ['testing'], undefined, {
        testing: ['typescript', 'rust'],
      }),
    ).toEqual({ testing: ['typescript'] });
  });
});
