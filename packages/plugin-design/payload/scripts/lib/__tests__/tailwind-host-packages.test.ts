import { describe, expect, it } from 'vitest';

import {
  resolveHostPackage,
  OXIDE_PACKAGE,
  TAILWIND_PACKAGE,
} from '../tailwind-host-packages.mts';
import {
  useBareRepo,
  usePnpmTailwindRepo,
  useTailwindRepo,
} from '#test/tailwind-fixture';

describe('resolveHostPackage', () => {
  it('resolves tailwindcss to its version and its ESM entry module', () => {
    const root = useTailwindRepo();

    const result = resolveHostPackage(root, TAILWIND_PACKAGE);

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe('4.3.3');
    expect(result.value.entryModuleUrl).toMatch(/dist\/lib\.mjs$/);
  });

  it('reports the install command when tailwindcss is not installed', () => {
    const root = useBareRepo();

    const result = resolveHostPackage(root, TAILWIND_PACKAGE);

    expect(result.ok, result.ok ? JSON.stringify(result.value) : '').toBe(
      false,
    );
    if (result.ok) return;
    expect(result.error).toContain('npm install -D tailwindcss@4');
  });

  it('fails to resolve @tailwindcss/oxide in a repo built without withOxide, never following the tailwindcss symlink out of the repo', () => {
    const root = useTailwindRepo();

    const oxide = resolveHostPackage(root, OXIDE_PACKAGE);
    const tailwind = resolveHostPackage(root, TAILWIND_PACKAGE);

    expect(oxide.ok, oxide.ok ? JSON.stringify(oxide.value) : '').toBe(false);
    expect(tailwind.ok, tailwind.ok ? '' : tailwind.error).toBe(true);
  });

  it('resolves a transitive oxide through the pnpm virtual store when only tailwindcss is linked at the top level', () => {
    const root = usePnpmTailwindRepo();

    const result = resolveHostPackage(root, OXIDE_PACKAGE);

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe('4.3.3');
  });

  it('resolves a transitive oxide nested under @tailwindcss/vite rather than tailwindcss', () => {
    const root = usePnpmTailwindRepo({ anchor: '@tailwindcss/vite' });

    const result = resolveHostPackage(root, OXIDE_PACKAGE);

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe('4.3.3');
  });
});
