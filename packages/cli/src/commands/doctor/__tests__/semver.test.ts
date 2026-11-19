import { describe, expect, it } from 'vitest';

import { compareSemver, parseSemver } from '../semver.js';

function sign(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) throw new Error('fixture did not parse');
  return Math.sign(compareSemver(parsedLeft, parsedRight));
}

describe('parseSemver', () => {
  it.each(['nightly', '1.2', '1.2.3.4', '', '1.2.x', '1.2.3-'])(
    'returns null for %j',
    (garbage) => {
      expect(parseSemver(garbage)).toBeNull();
    },
  );

  it('splits the prerelease into identifiers and keeps the release numbers', () => {
    expect(parseSemver('2.1.300-beta.1')).toEqual({
      release: [2, 1, 300],
      prerelease: ['beta', '1'],
    });
  });
});

describe('compareSemver', () => {
  it('treats a v prefix as equal to the bare version', () => {
    expect(sign('v1.2.3', '1.2.3')).toBe(0);
  });

  it('ignores build metadata', () => {
    expect(sign('1.2.3+build.5', '1.2.3')).toBe(0);
  });

  it('compares release numbers numerically', () => {
    expect(sign('2.1.9', '2.1.288')).toBe(-1);
    expect(sign('2.1.1000', '2.1.314')).toBe(1);
  });

  it('sorts a prerelease below its release', () => {
    expect(sign('1.2.3-beta.1', '1.2.3')).toBe(-1);
    expect(sign('1.2.3', '1.2.3-beta.1')).toBe(1);
  });

  it('sorts a numeric identifier below an alphanumeric one', () => {
    expect(sign('1.2.3-1', '1.2.3-alpha')).toBe(-1);
    expect(sign('1.2.3-alpha', '1.2.3-1')).toBe(1);
  });

  it('compares numeric identifiers as numbers', () => {
    expect(sign('1.2.3-beta.2', '1.2.3-beta.10')).toBe(-1);
  });

  it('sorts a longer prerelease above its prefix', () => {
    expect(sign('1.2.3-beta.1', '1.2.3-beta')).toBe(1);
    expect(sign('1.2.3-beta', '1.2.3-beta.1')).toBe(-1);
  });

  it('compares alphanumeric identifiers lexically', () => {
    expect(sign('1.2.3-alpha', '1.2.3-beta')).toBe(-1);
  });
});
