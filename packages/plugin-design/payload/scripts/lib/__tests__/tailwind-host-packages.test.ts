import { describe, expect, it } from 'vitest';

import {
  resolveHostPackage,
  OXIDE_PACKAGE,
  TAILWIND_PACKAGE,
} from '../tailwind-host-packages.mts';
import { useBareRepo, useTailwindRepo } from '#test/tailwind-fixture';

describe('resolveHostPackage', () => {
  it('resolves tailwindcss to its version and its ESM entry module', () => {
    const root = useTailwindRepo();

    const result = resolveHostPackage(root, TAILWIND_PACKAGE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe('4.3.3');
    expect(result.value.entryModuleUrl.endsWith('dist/lib.mjs')).toBe(true);
  });

  it('reports the install command when tailwindcss is not installed', () => {
    const root = useBareRepo();

    const result = resolveHostPackage(root, TAILWIND_PACKAGE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('npm install -D tailwindcss@4');
  });

  it('fails to resolve @tailwindcss/oxide in a repo built without withOxide', () => {
    const root = useTailwindRepo();

    const oxide = resolveHostPackage(root, OXIDE_PACKAGE);
    const tailwind = resolveHostPackage(root, TAILWIND_PACKAGE);

    expect(oxide.ok).toBe(false);
    expect(tailwind.ok).toBe(true);
  });
});
