import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const EMITTED_SCRIPTS_DIR = fileURLToPath(
  new URL('../../payload-dist/scripts', import.meta.url),
);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function importAndExportSpecifiersOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(
    /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g,
  )) {
    out.push(m[1]!);
  }
  for (const m of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push(m[1]!);
  }
  for (const m of source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
    out.push(m[1]!);
  }
  return out;
}

/**
 * No bare import is sanctioned here, unlike the CLI's rename.mjs. This package's Tailwind
 * libs do drive the host repo's own Tailwind install, but they never name `tailwindcss` or
 * `@tailwindcss/oxide` as a static specifier: `tailwind-host-packages.mts` locates those
 * packages by walking `node_modules` from the host root and reading their manifests, then
 * `tailwind-design-system.mts` imports the resolved entry with `pathToFileURL` and a
 * variable passed to `import()`. Resolution by path is forced by Tailwind's own packaging,
 * not chosen for its own sake: measured and recorded in
 * `.claude/plans/design-tailwind/SPIKE.md`, `require.resolve('tailwindcss')` returns the CJS
 * entry, and importing that entry yields `__unstable__loadDesignSystem === undefined` rather
 * than throwing, so the `import` condition read out of the manifest is the only route that
 * works. The consequence is that no bare Tailwind specifier survives into the emitted
 * payload at all, so the zero-dependency invariant holds by construction and not by
 * exception.
 */
const ALLOWED_BARE_IMPORTS: Record<string, string[]> = {};

const scripts = walk(EMITTED_SCRIPTS_DIR).filter((f) => f.endsWith('.mjs'));

describe('the emitted payload script tree', () => {
  it('has scripts to check', () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  it('imports only node builtins, relative paths, or an explicitly allowed bare import', () => {
    const offenders: string[] = [];
    for (const file of scripts) {
      const rel = file.slice(EMITTED_SCRIPTS_DIR.length + 1);
      const allowed = ALLOWED_BARE_IMPORTS[rel] ?? [];
      for (const spec of importAndExportSpecifiersOf(
        readFileSync(file, 'utf8'),
      )) {
        const ok =
          spec.startsWith('node:') ||
          spec.startsWith('.') ||
          allowed.includes(spec);
        if (!ok) offenders.push(`${rel} → ${spec}`);
      }
    }
    expect(
      offenders,
      'payload is copied into user repos and must run on bare node',
    ).toEqual([]);
  });

  it('never names tailwindcss or @tailwindcss/oxide as a static import specifier, since resolution must go by path', () => {
    const offenders: string[] = [];
    for (const file of scripts) {
      const rel = file.slice(EMITTED_SCRIPTS_DIR.length + 1);
      for (const spec of importAndExportSpecifiersOf(
        readFileSync(file, 'utf8'),
      )) {
        if (spec === 'tailwindcss' || spec === '@tailwindcss/oxide') {
          offenders.push(`${rel} → ${spec}`);
        }
      }
    }
    expect(
      offenders,
      'a bare Tailwind specifier here means a later phase wired the host package in ' +
        'by name instead of resolving it by path from the host node_modules, which ' +
        'breaks the zero-dependency payload invariant. Resolve it via ' +
        'tailwind-host-packages.mts and import the resolved path instead.',
    ).toEqual([]);
  });
});
