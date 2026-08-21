import { describe, expect, it } from 'vitest';
import type { JsonObject } from 'type-fest';

import {
  deepMerge,
  deepRemove,
  isPlainObject,
  parseHostJson,
  parseJsonObject,
} from '../json-merge.js';

describe('deepMerge', () => {
  it('recurses into nested objects rather than clobbering them', () => {
    const target: JsonObject = { a: { x: 1, y: 2 }, b: 'keep' };
    const patch: JsonObject = { a: { y: 3, z: 4 } };
    expect(deepMerge(target, patch)).toEqual({
      a: { x: 1, y: 3, z: 4 },
      b: 'keep',
    });
  });

  it('overwrites scalars', () => {
    const target: JsonObject = { count: 1, name: 'old' };
    const patch: JsonObject = { count: 2 };
    expect(deepMerge(target, patch)).toEqual({ count: 2, name: 'old' });
  });

  it('unions arrays without duplicating structurally-equal elements', () => {
    const target: JsonObject = { list: [1, { id: 'a' }] };
    const patch: JsonObject = { list: [{ id: 'a' }, { id: 'b' }] };
    expect(deepMerge(target, patch)).toEqual({
      list: [1, { id: 'a' }, { id: 'b' }],
    });
  });

  it('changes nothing on a second merge of the same patch (idempotent)', () => {
    const target: JsonObject = { hooks: { PostToolUse: [{ id: 'a' }] } };
    const patch: JsonObject = {
      hooks: { PostToolUse: [{ id: 'a' }, { id: 'b' }] },
    };
    const once = deepMerge(target, patch);
    const twice = deepMerge(once, patch);
    expect(twice).toEqual(once);
  });

  it('does not mutate its arguments', () => {
    const target: JsonObject = { a: { x: 1 }, list: [1] };
    const patch: JsonObject = { a: { y: 2 }, list: [2] };
    const targetBefore = JSON.parse(JSON.stringify(target));
    const patchBefore = JSON.parse(JSON.stringify(patch));
    deepMerge(target, patch);
    expect(target).toEqual(targetBefore);
    expect(patch).toEqual(patchBefore);
  });

  it('leaves keys the patch does not mention untouched', () => {
    const target: JsonObject = { untouched: { deep: true }, changed: 1 };
    const patch: JsonObject = { changed: 2 };
    expect(deepMerge(target, patch).untouched).toEqual({ deep: true });
  });
});

describe('deepRemove', () => {
  it('deletes a scalar key', () => {
    const target: JsonObject = { a: 1, b: 2 };
    const patch: JsonObject = { a: 1 };
    expect(deepRemove(target, patch)).toEqual({ b: 2 });
  });

  it('removes array elements by structural equality, leaving unrelated ones', () => {
    const target: JsonObject = { list: [{ id: 'a' }, { id: 'b' }, 3] };
    const patch: JsonObject = { list: [{ id: 'a' }] };
    expect(deepRemove(target, patch)).toEqual({ list: [{ id: 'b' }, 3] });
  });

  it('recurses into nested objects', () => {
    const target: JsonObject = { a: { x: 1, y: 2 }, b: 'keep' };
    const patch: JsonObject = { a: { y: 2 } };
    expect(deepRemove(target, patch)).toEqual({ a: { x: 1 }, b: 'keep' });
  });

  it('prunes a container emptied by removal', () => {
    const target: JsonObject = { a: { x: 1 }, list: [{ id: 'a' }] };
    const patch: JsonObject = { a: { x: 1 }, list: [{ id: 'a' }] };
    expect(deepRemove(target, patch)).toEqual({});
  });

  it('leaves keys the patch does not mention untouched', () => {
    const target: JsonObject = { untouched: { deep: true }, a: 1 };
    const patch: JsonObject = { a: 1 };
    expect(deepRemove(target, patch).untouched).toEqual({ deep: true });
  });

  it('does not mutate its arguments', () => {
    const target: JsonObject = { a: { x: 1, y: 2 }, list: [1, 2] };
    const patch: JsonObject = { a: { y: 2 }, list: [2] };
    const targetBefore = JSON.parse(JSON.stringify(target));
    const patchBefore = JSON.parse(JSON.stringify(patch));
    deepRemove(target, patch);
    expect(target).toEqual(targetBefore);
    expect(patch).toEqual(patchBefore);
  });

  it('restores the base object when undoing a prior deepMerge with the same patch, for a nested array-of-objects fixture', () => {
    const base: JsonObject = {
      permissions: { allow: ['Bash(git status)'] },
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'node ./user-hook.js' }],
          },
        ],
      },
      other: { untouched: true },
    };
    const patch: JsonObject = {
      permissions: { allow: ['Bash(git diff)'] },
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'node ./kit-hook.mjs' }],
          },
        ],
      },
    };
    const merged = deepMerge(base, patch);
    const restored = deepRemove(merged, patch);
    expect(restored).toEqual(base);
  });
});

describe('isPlainObject', () => {
  it.each([
    { value: {}, expected: true },
    { value: { a: 1 }, expected: true },
    { value: [], expected: false },
    { value: null, expected: false },
    { value: 'x', expected: false },
    { value: 1, expected: false },
  ])('returns $expected for $value', ({ value, expected }) => {
    expect(isPlainObject(value)).toBe(expected);
  });
});

describe('parseHostJson', () => {
  it.each(['', '  \n '])('treats %j as {}', (input) => {
    expect(parseHostJson(input)).toEqual({});
  });

  it('parses real object text', () => {
    expect(parseHostJson('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('parseJsonObject', () => {
  it.each(['[]', '"x"'])('throws on non-object JSON %j', (input) => {
    expect(() => parseJsonObject(input)).toThrow();
  });

  it('parses object text', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
});
