// The payload's zero-runtime-dependency rule, enforced rather than documented.
//
// Everything under payload/scripts is copied into user repos and run by node with
// whatever that repo happens to have installed — which may be nothing. A stray
// `import { z } from 'zod'` would not fail here; it would fail on a stranger's
// machine, inside a hook, on every tool call. So: node builtins and relative paths
// only.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// The EMITTED tree, not the .mts sources: what ships and what a user's node runs.
// Checking the sources would miss anything the compiler could inject.
const PAYLOAD_SCRIPTS = fileURLToPath(
  new URL('../payload-dist/scripts', import.meta.url),
);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Every static import/export specifier and dynamic import() target in a module. */
function specifiersOf(source: string): string[] {
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
 * that repo already has rather than one the kit ships. It is also agent-invoked
 * rather than hook-wired, and its module only installs when TypeScript is detected —
 * so a missing `typescript` is a legible error on an explicit command, never silent
 * breakage on every tool call. Anything else added here needs the same three
 * properties.
 */
const ALLOWED_BARE_IMPORTS: Record<string, string[]> = {
  'rename.mjs': ['typescript'],
};

const scripts = walk(PAYLOAD_SCRIPTS).filter((f) => f.endsWith('.mjs'));

test('PD1: there are payload scripts to check', () => {
  expect(scripts.length).toBeGreaterThan(0);
});

test('PD2: every payload script imports only node builtins and relative paths', () => {
  const offenders: string[] = [];
  for (const file of scripts) {
    const rel = file.slice(PAYLOAD_SCRIPTS.length + 1);
    const allowed = ALLOWED_BARE_IMPORTS[rel] ?? [];
    for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
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

test('PD3: the config loader in particular pulls in no dependency', () => {
  // Called by every hook. If anything here needs installing, every hook in every
  // repo dies at once — this is the single highest-blast-radius file in the payload.
  const source = readFileSync(
    join(PAYLOAD_SCRIPTS, 'lib/kit-config.mjs'),
    'utf8',
  );
  for (const spec of specifiersOf(source)) {
    expect(spec.startsWith('node:') || spec.startsWith('.')).toBe(true);
  }
  expect(source).not.toMatch(/\bfrom\s+['"]zod['"]/);
});
