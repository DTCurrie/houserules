import { describe, expect, it } from 'vitest';

import { mergeManagedKeys } from '../merge-config-keys.js';

const USER_CONFIG = `${JSON.stringify(
  {
    version: 2,
    packageManager: 'pnpm',
    guard: { gitCommit: true },
    targets: [{ name: 'web', prefix: 'WEB' }],
  },
  null,
  2,
)}\n`;

function canonicalWith(extra: Record<string, unknown>): string {
  return `${JSON.stringify({ version: 2, ...extra }, null, 2)}\n`;
}

function mergedObject(
  disk: string,
  canonical: string,
  keys: string[] = ['moduleOptions'],
): Record<string, unknown> {
  const text = mergeManagedKeys(disk, canonical, keys);
  if (text === null) throw new Error('expected a merge, received null');
  return JSON.parse(text) as Record<string, unknown>;
}

describe('mergeManagedKeys', () => {
  it('adds a managed key the file does not carry yet', () => {
    const canonical = canonicalWith({
      moduleOptions: { 'a11y/a': ['svelte'] },
    });

    const merged = mergedObject(USER_CONFIG, canonical);

    expect(merged.moduleOptions).toEqual({ 'a11y/a': ['svelte'] });
  });

  it('leaves every unmanaged key byte-identical to what the user wrote', () => {
    const canonical = canonicalWith({
      moduleOptions: { 'a11y/a': ['svelte'] },
      packageManager: 'npm',
    });

    const merged = mergedObject(USER_CONFIG, canonical);

    expect(merged.packageManager).toBe('pnpm');
    expect(merged.guard).toEqual({ gitCommit: true });
    expect(merged.targets).toEqual([{ name: 'web', prefix: 'WEB' }]);
  });

  it('returns null when the managed key already holds the wanted value', () => {
    const canonical = canonicalWith({ moduleOptions: { 'a11y/a': ['html'] } });
    const already = mergeManagedKeys(USER_CONFIG, canonical, ['moduleOptions']);

    const second = mergeManagedKeys(already ?? '', canonical, [
      'moduleOptions',
    ]);

    expect(second).toBeNull();
  });

  it('replaces a managed key whose recorded value differs', () => {
    const withHtml =
      mergeManagedKeys(
        USER_CONFIG,
        canonicalWith({ moduleOptions: { 'a11y/a': ['html'] } }),
        ['moduleOptions'],
      ) ?? '';

    const merged = mergedObject(
      withHtml,
      canonicalWith({ moduleOptions: { 'a11y/a': ['svelte'] } }),
    );

    expect(merged.moduleOptions).toEqual({ 'a11y/a': ['svelte'] });
  });

  it('removes a managed key the canonical render omits, so a withdrawal is not re-read as a selection', () => {
    const withOptions =
      mergeManagedKeys(
        USER_CONFIG,
        canonicalWith({ moduleOptions: { 'a11y/a': ['html'] } }),
        ['moduleOptions'],
      ) ?? '';

    const merged = mergedObject(withOptions, canonicalWith({}));

    expect('moduleOptions' in merged).toBe(false);
  });

  it('returns null when the file on disk is not valid JSON', () => {
    const result = mergeManagedKeys(
      '{ "version": 2,,, }',
      canonicalWith({ moduleOptions: { 'a11y/a': ['html'] } }),
      ['moduleOptions'],
    );

    expect(result).toBeNull();
  });

  it('returns null when the file on disk parses to an array rather than an object', () => {
    const result = mergeManagedKeys(
      '[1, 2, 3]',
      canonicalWith({ moduleOptions: { 'a11y/a': ['html'] } }),
      ['moduleOptions'],
    );

    expect(result).toBeNull();
  });

  it('ends the merged file with a trailing newline', () => {
    const text = mergeManagedKeys(
      USER_CONFIG,
      canonicalWith({ moduleOptions: { 'a11y/a': ['html'] } }),
      ['moduleOptions'],
    );

    expect(text?.endsWith('}\n')).toBe(true);
  });
});
