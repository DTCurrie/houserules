import { describe, expect, it } from 'vitest';

import { HouseError } from '../house-error.js';
import {
  assertOptionsRecorded,
  parseModuleOptionFlags,
  resolveModuleOptions,
} from '../module-options.js';
import type { ModuleDef } from '@houserules/api';
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

function suggestionFor(registry: Registry, id: string): string {
  try {
    assertOptionsRecorded(registry, [id], {});
  } catch (error) {
    return (error as HouseError).message;
  }
  throw new Error(`assertOptionsRecorded did not throw for "${id}"`);
}

function moduleOptionArgsIn(suggestion: string): string[] {
  return [...suggestion.matchAll(/--module-option (\S+)/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
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
    expect(() => parseModuleOptionFlags(['testing'])).toThrow(HouseError);
  });

  it('throws when the id is empty', () => {
    expect(() => parseModuleOptionFlags(['=typescript'])).toThrow(HouseError);
  });

  it('throws when the value list is empty', () => {
    expect(() => parseModuleOptionFlags(['testing='])).toThrow(HouseError);
  });

  it('throws when the value list is only a trailing comma', () => {
    expect(() => parseModuleOptionFlags(['testing=,'])).toThrow(HouseError);
  });

  it('throws when an id repeats across two flags', () => {
    expect(() =>
      parseModuleOptionFlags(['testing=typescript', 'testing=javascript']),
    ).toThrow(HouseError);
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

describe('assertOptionsRecorded', () => {
  const registry = registryOf([
    moduleWithOptions('langs', ['alpha', 'beta'], ['alpha']),
    moduleWithOptions('none', ['alpha', 'beta'], []),
    {
      id: 'plain',
      title: 'plain',
      group: 'optional',
      hint: () => '',
      defaultEnabled: () => true,
      plan: () => [],
    },
  ]);

  it('passes when the module has a recorded selection', () => {
    expect(() =>
      assertOptionsRecorded(registry, ['langs'], { langs: ['beta'] }),
    ).not.toThrow();
  });

  it('passes when a selection is named on the command line this run', () => {
    expect(() =>
      assertOptionsRecorded(registry, ['langs'], undefined, {
        langs: ['beta'],
      }),
    ).not.toThrow();
  });

  it('passes for an enabled module that declares no options', () => {
    expect(() =>
      assertOptionsRecorded(registry, ['plain'], undefined),
    ).not.toThrow();
  });

  it('passes when the option-bearing module is not enabled', () => {
    expect(() =>
      assertOptionsRecorded(registry, ['plain'], { plain: [] }),
    ).not.toThrow();
  });

  it('throws a HouseError when an enabled option-bearing module has no recorded selection', () => {
    expect(() => assertOptionsRecorded(registry, ['langs'], undefined)).toThrow(
      HouseError,
    );
  });

  it('names the module whose selection is unrecorded', () => {
    expect(() => assertOptionsRecorded(registry, ['langs'], {})).toThrow(
      /No recorded option selection for: langs/,
    );
  });

  it('quotes a runnable reconfigure command carrying the module defaults', () => {
    expect(() => assertOptionsRecorded(registry, ['langs'], {})).toThrow(
      /--reconfigure=langs --module-option langs=alpha/,
    );
  });

  it('points at --force as the way to accept the defaults', () => {
    expect(() => assertOptionsRecorded(registry, ['langs'], {})).toThrow(
      /--force/,
    );
  });

  it('treats a recorded empty selection as recorded, since choosing nothing is a choice', () => {
    expect(() =>
      assertOptionsRecorded(registry, ['langs'], { langs: [] }),
    ).not.toThrow();
  });

  describe('the suggested fix command', () => {
    it.each(['langs', 'none'])(
      'carries a --module-option argument the flag parser accepts, for %s',
      (id) => {
        const suggestion = suggestionFor(registry, id);

        expect(() =>
          parseModuleOptionFlags(moduleOptionArgsIn(suggestion)),
        ).not.toThrow();
      },
    );

    it('drops --module-option entirely when the module declares no defaults', () => {
      expect(suggestionFor(registry, 'none')).toMatch(/--reconfigure=none$/m);
    });
  });
});
