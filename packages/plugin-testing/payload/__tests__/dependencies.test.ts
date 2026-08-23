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
 * No bare import is sanctioned here. Every cross-package dependency this plugin's
 * scripts have reaches `@houserules/payload/*`, which `houserules-payload` rewrites to a
 * relative `./lib/` specifier before emit, so none should survive as a bare name.
 */
const ALLOWED_BARE_IMPORTS: Record<string, string[]> = {};

const allScripts = walk(EMITTED_SCRIPTS_DIR).filter((f) => f.endsWith('.mjs'));
const topLevelScripts = readdirSync(EMITTED_SCRIPTS_DIR).filter((f) =>
  f.endsWith('.mjs'),
);

describe('the emitted payload script tree', () => {
  it('has scripts to check', () => {
    expect(allScripts.length).toBe(2);
  });

  it.each(topLevelScripts)('%s keeps its shebang', (file) => {
    const source = readFileSync(join(EMITTED_SCRIPTS_DIR, file), 'utf8');
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it.each(topLevelScripts)(
    '%s emits no tslib or downlevel helper the source minus types would not have',
    (file) => {
      const source = readFileSync(join(EMITTED_SCRIPTS_DIR, file), 'utf8');
      expect(source).not.toMatch(/__awaiter|__generator|tslib|__importDefault/);
    },
  );

  it('imports only node builtins, relative paths, or an explicitly allowed bare import', () => {
    const offenders: string[] = [];
    for (const file of allScripts) {
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

  it('rewrites every @houserules/payload/ specifier before emit, leaving none behind', () => {
    const offenders: string[] = [];
    for (const file of allScripts) {
      const rel = file.slice(EMITTED_SCRIPTS_DIR.length + 1);
      for (const spec of importAndExportSpecifiersOf(
        readFileSync(file, 'utf8'),
      )) {
        if (spec.startsWith('@houserules/')) offenders.push(`${rel} → ${spec}`);
      }
    }
    expect(
      offenders,
      'an emitted script must never import a workspace package by name, since it is copied into a user repo where that package does not resolve',
    ).toEqual([]);
  });
});
