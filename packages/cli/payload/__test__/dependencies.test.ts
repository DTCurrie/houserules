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
 * The one sanctioned bare import, and why it does not violate the rule: rename.mjs
 * drives the TARGET REPO's own TypeScript LanguageService, so it consumes a package
 * that repo already has rather than one houserules ships. It is also agent-invoked
 * rather than hook-wired, and its module only installs when TypeScript is detected.
 * A missing `typescript` is a legible error on an explicit command, never silent
 * breakage on every tool call. Anything else added here needs the same three
 * properties.
 */
const ALLOWED_BARE_IMPORTS: Record<string, string[]> = {
  'rename.mjs': ['typescript'],
};

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

  it('rewrites every @houserules/cli/payload/ specifier before emit, leaving none behind', () => {
    const offenders: string[] = [];
    for (const file of scripts) {
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

describe('lib/config.mjs, the highest-blast-radius file since every hook calls it', () => {
  const source = readFileSync(
    join(EMITTED_SCRIPTS_DIR, 'lib/config.mjs'),
    'utf8',
  );

  it('imports only node builtins or relative paths', () => {
    expect(
      importAndExportSpecifiersOf(source).filter(
        (spec) => !spec.startsWith('node:') && !spec.startsWith('.'),
      ),
    ).toEqual([]);
  });

  it('does not import zod', () => {
    expect(source).not.toMatch(/\bfrom\s+['"]zod['"]/);
  });
});
