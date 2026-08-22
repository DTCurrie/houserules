import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MANIFEST_PATH } from '@houserules/api/internal';
import { useInstalledRepo, useRepo } from '#test/repo';
import { detect } from '../../../detect.js';
import { checkScriptImports, importSpecifiersIn } from '../script-imports.js';

function write(root: string, rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

function trackFile(root: string, dest: string): void {
  const manifestPath = join(root, MANIFEST_PATH);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    files: Record<string, string>;
  };
  manifest.files[dest] = 'hash';
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

function messages(root: string): string[] {
  return checkScriptImports(root, detect(root)).findings.map((f) => f.msg);
}

describe('importSpecifiersIn', () => {
  it('collects static, side-effect, re-export, and dynamic forms once each', () => {
    const text = [
      "import { a } from './lib/a.mjs';",
      "import {\n  b,\n  c,\n} from './lib/b.mjs';",
      "import './lib/effect.mjs';",
      "export { d } from './lib/d.mjs';",
      "const e = await import('./lib/e.mjs');",
      "import { a as again } from './lib/a.mjs';",
    ].join('\n');
    expect(
      importSpecifiersIn(text).sort((x, y) =>
        x.specifier.localeCompare(y.specifier),
      ),
    ).toEqual([
      { specifier: './lib/a.mjs', dynamic: false },
      { specifier: './lib/b.mjs', dynamic: false },
      { specifier: './lib/d.mjs', dynamic: false },
      { specifier: './lib/e.mjs', dynamic: true },
      { specifier: './lib/effect.mjs', dynamic: false },
    ]);
  });

  it('counts a specifier imported both ways as static', () => {
    const text = [
      "import { a } from './lib/a.mjs';",
      "const again = await import('./lib/a.mjs');",
    ].join('\n');
    expect(importSpecifiersIn(text)).toEqual([
      { specifier: './lib/a.mjs', dynamic: false },
    ]);
  });

  it('ignores a commented-out import', () => {
    expect(importSpecifiersIn("// import { x } from './gone.mjs';")).toEqual(
      [],
    );
  });
});

describe('checkScriptImports', () => {
  it('passes the intact installed tree and counts it in the readout', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    const result = checkScriptImports(root, detect(root));

    expect(result.findings).toEqual([]);
    expect(result.readouts[0]).toMatch(/^script imports: \d+ import\(s\)/);
  });

  it('reports the importing script and specifier when a lib file is missing', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    write(
      root,
      '.claude/scripts/probe.mjs',
      "import { probe } from './lib/probe-lib.mjs';\nprobe();\n",
    );
    write(
      root,
      '.claude/scripts/lib/probe-lib.mjs',
      'export const probe = () => {};\n',
    );
    expect(messages(root)).toEqual([]);

    rmSync(join(root, '.claude/scripts/lib/probe-lib.mjs'));

    const [finding, ...rest] = checkScriptImports(root, detect(root)).findings;
    expect(rest).toEqual([]);
    expect(finding?.msg).toContain(join('.claude', 'scripts', 'probe.mjs'));
    expect(finding?.msg).toContain('./lib/probe-lib.mjs');
    expect(finding?.level).toBe('ERROR');
  });

  it('stays silent on a missing dynamic import the manifest does not track, since an optional feature installs its lib only when chosen', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    write(
      root,
      '.claude/scripts/probe.mjs',
      "const mod = await import('./lib/lazy.mjs');\n",
    );

    expect(messages(root)).toEqual([]);
  });

  it('reports a missing dynamic import the manifest tracks', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    write(
      root,
      '.claude/scripts/probe.mjs',
      "const mod = await import('./lib/lazy.mjs');\n",
    );
    trackFile(root, '.claude/scripts/lib/lazy.mjs');

    const found = messages(root);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('./lib/lazy.mjs');
    expect(found[0]).toContain('manifest tracks');
  });

  it('flags a static bare specifier but not node builtins or a dynamic host probe', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    write(
      root,
      '.claude/scripts/probe.mjs',
      [
        "import { gone } from 'not-a-real-package';",
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'path';",
        "const host = await import('also-not-a-real-package');",
      ].join('\n'),
    );

    const found = messages(root);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('not-a-real-package');
    expect(found[0]).toContain('bare specifier');
  });

  it('is silent when no scripts directory exists', () => {
    const root = useRepo('pnpm-monorepo');

    expect(checkScriptImports(root, detect(root))).toEqual({
      findings: [],
      readouts: [],
    });
  });
});
