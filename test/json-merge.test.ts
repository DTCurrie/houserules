import { expect, test } from 'vitest';
import type { JsonObject } from 'type-fest';

import {
  deepMerge,
  deepRemove,
  isPlainObject,
  parseHostJson,
  parseJsonObject,
} from '../src/core/json-merge.js';

test('JM1: deepMerge recurses into nested objects rather than clobbering them', () => {
  const target: JsonObject = { a: { x: 1, y: 2 }, b: 'keep' };
  const patch: JsonObject = { a: { y: 3, z: 4 } };
  expect(deepMerge(target, patch)).toEqual({
    a: { x: 1, y: 3, z: 4 },
    b: 'keep',
  });
});

test('JM2: deepMerge overwrites scalars', () => {
  const target: JsonObject = { count: 1, name: 'old' };
  const patch: JsonObject = { count: 2 };
  expect(deepMerge(target, patch)).toEqual({ count: 2, name: 'old' });
});

test('JM3: deepMerge unions arrays without duplicating structurally-equal elements', () => {
  const target: JsonObject = { list: [1, { id: 'a' }] };
  const patch: JsonObject = { list: [{ id: 'a' }, { id: 'b' }] };
  expect(deepMerge(target, patch)).toEqual({
    list: [1, { id: 'a' }, { id: 'b' }],
  });
});

test('JM4: merging the same patch twice changes nothing the second time', () => {
  const target: JsonObject = { hooks: { PostToolUse: [{ id: 'a' }] } };
  const patch: JsonObject = {
    hooks: { PostToolUse: [{ id: 'a' }, { id: 'b' }] },
  };
  const once = deepMerge(target, patch);
  const twice = deepMerge(once, patch);
  expect(twice).toEqual(once);
});

test('JM5: deepMerge does not mutate its arguments', () => {
  const target: JsonObject = { a: { x: 1 }, list: [1] };
  const patch: JsonObject = { a: { y: 2 }, list: [2] };
  const targetBefore = JSON.parse(JSON.stringify(target));
  const patchBefore = JSON.parse(JSON.stringify(patch));
  deepMerge(target, patch);
  expect(target).toEqual(targetBefore);
  expect(patch).toEqual(patchBefore);
});

test('JM6: deepMerge leaves keys the patch does not mention untouched', () => {
  const target: JsonObject = { untouched: { deep: true }, changed: 1 };
  const patch: JsonObject = { changed: 2 };
  expect(deepMerge(target, patch).untouched).toEqual({ deep: true });
});

test('JM7: deepRemove deletes a scalar key', () => {
  const target: JsonObject = { a: 1, b: 2 };
  const patch: JsonObject = { a: 1 };
  expect(deepRemove(target, patch)).toEqual({ b: 2 });
});

test('JM8: deepRemove removes array elements by structural equality, leaving unrelated ones', () => {
  const target: JsonObject = { list: [{ id: 'a' }, { id: 'b' }, 3] };
  const patch: JsonObject = { list: [{ id: 'a' }] };
  expect(deepRemove(target, patch)).toEqual({ list: [{ id: 'b' }, 3] });
});

test('JM9: deepRemove recurses into nested objects', () => {
  const target: JsonObject = { a: { x: 1, y: 2 }, b: 'keep' };
  const patch: JsonObject = { a: { y: 2 } };
  expect(deepRemove(target, patch)).toEqual({ a: { x: 1 }, b: 'keep' });
});

test('JM10: deepRemove prunes a container emptied by removal', () => {
  const target: JsonObject = { a: { x: 1 }, list: [{ id: 'a' }] };
  const patch: JsonObject = { a: { x: 1 }, list: [{ id: 'a' }] };
  expect(deepRemove(target, patch)).toEqual({});
});

test('JM11: deepRemove leaves keys the patch does not mention untouched', () => {
  const target: JsonObject = { untouched: { deep: true }, a: 1 };
  const patch: JsonObject = { a: 1 };
  expect(deepRemove(target, patch).untouched).toEqual({ deep: true });
});

test('JM12: deepRemove does not mutate its arguments', () => {
  const target: JsonObject = { a: { x: 1, y: 2 }, list: [1, 2] };
  const patch: JsonObject = { a: { y: 2 }, list: [2] };
  const targetBefore = JSON.parse(JSON.stringify(target));
  const patchBefore = JSON.parse(JSON.stringify(patch));
  deepRemove(target, patch);
  expect(target).toEqual(targetBefore);
  expect(patch).toEqual(patchBefore);
});

test('JM13: round-trip — deepRemove(deepMerge(base, patch), patch) restores base for a nested, array-of-objects fixture', () => {
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

test('JM14: isPlainObject distinguishes plain objects from arrays, null, and scalars', () => {
  expect(isPlainObject({})).toBe(true);
  expect(isPlainObject({ a: 1 })).toBe(true);
  expect(isPlainObject([])).toBe(false);
  expect(isPlainObject(null)).toBe(false);
  expect(isPlainObject('x')).toBe(false);
  expect(isPlainObject(1)).toBe(false);
});

test('JM15: parseHostJson treats blank/whitespace text as {}', () => {
  expect(parseHostJson('')).toEqual({});
  expect(parseHostJson('  \n ')).toEqual({});
});

test('JM16: parseHostJson parses real object text', () => {
  expect(parseHostJson('{"a":1}')).toEqual({ a: 1 });
});

test('JM17: parseJsonObject throws on non-object JSON', () => {
  expect(() => parseJsonObject('[]')).toThrow();
  expect(() => parseJsonObject('"x"')).toThrow();
});

test('JM18: parseJsonObject parses object text', () => {
  expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
});
