import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  importedRelativeLibNames,
  verifyPackage,
} from '../verify-payload-lib-declarations.mjs';

describe('importedRelativeLibNames, forms it sees', () => {
  it('named import', () => {
    assert.deepEqual(
      importedRelativeLibNames(`import { a, b } from './lib/alpha.mjs';`),
      ['alpha'],
    );
  });

  it('default import with double quotes', () => {
    assert.deepEqual(
      importedRelativeLibNames(`import beta from "./lib/beta-lib.mjs"`),
      ['beta-lib'],
    );
  });

  it('namespace import', () => {
    assert.deepEqual(
      importedRelativeLibNames(`import   *  as ns   from   './gamma.mjs';`),
      ['gamma'],
    );
  });

  it('default plus named import', () => {
    assert.deepEqual(
      importedRelativeLibNames(`import d, { e } from './lib/delta.mjs';`),
      ['delta'],
    );
  });

  it('multi-line named import', () => {
    const source = `import {\n  one,\n  two,\n} from\n  './lib/epsilon.mjs';`;
    assert.deepEqual(importedRelativeLibNames(source), ['epsilon']);
  });

  it('export { } from', () => {
    assert.deepEqual(
      importedRelativeLibNames(`export { z } from './lib/zeta.mjs';`),
      ['zeta'],
    );
  });

  it('export * from', () => {
    assert.deepEqual(
      importedRelativeLibNames(`export * from "./lib/eta.mjs";`),
      ['eta'],
    );
  });

  it('side-effect import, single quotes', () => {
    assert.deepEqual(importedRelativeLibNames(`import './lib/theta.mjs';`), [
      'theta',
    ]);
  });

  it('side-effect import, double quotes, no semicolon, extra spaces', () => {
    assert.deepEqual(
      importedRelativeLibNames(`import    "./lib/deep/iota.mjs"\nconst x = 1;`),
      ['iota'],
    );
  });

  it('side-effect import with no space before the quote', () => {
    assert.deepEqual(importedRelativeLibNames(`import'./kappa.mjs';`), [
      'kappa',
    ]);
  });

  it('dynamic import, single quotes', () => {
    assert.deepEqual(
      importedRelativeLibNames(`const m = await import('./lib/lambda.mjs');`),
      ['lambda'],
    );
  });

  it('dynamic import, double quotes, padded', () => {
    assert.deepEqual(
      importedRelativeLibNames(`await import(  "./lib/mu-lib.mjs"  )`),
      ['mu-lib'],
    );
  });

  it('dynamic import, backtick literal without substitution', () => {
    assert.deepEqual(
      importedRelativeLibNames('const m = await import(`./lib/nu.mjs`);'),
      ['nu'],
    );
  });

  it('dynamic import split across lines', () => {
    assert.deepEqual(importedRelativeLibNames(`import(\n  './lib/xi.mjs'\n)`), [
      'xi',
    ]);
  });

  it('returns each lib once across mixed forms', () => {
    const source = [
      `import { a } from './lib/omicron.mjs';`,
      `import './lib/omicron.mjs';`,
      `await import('./lib/pi.mjs');`,
    ].join('\n');
    assert.deepEqual(importedRelativeLibNames(source).sort(), [
      'omicron',
      'pi',
    ]);
  });
});

describe('importedRelativeLibNames, forms left out', () => {
  it('computed dynamic import through a variable', () => {
    assert.deepEqual(importedRelativeLibNames(`await import(specifier);`), []);
  });

  it('template literal with a substitution', () => {
    assert.deepEqual(
      importedRelativeLibNames('await import(`./lib/${name}.mjs`);'),
      [],
    );
  });

  it('pathToFileURL specifier', () => {
    assert.deepEqual(
      importedRelativeLibNames(
        `await import(pathToFileURL('./lib/rho.mjs').href);`,
      ),
      [],
    );
  });

  it('dynamic import with a concatenated string', () => {
    assert.deepEqual(
      importedRelativeLibNames(`await import('./lib/' + name + '.mjs');`),
      [],
    );
  });

  it('parent-relative import', () => {
    assert.deepEqual(
      importedRelativeLibNames(
        `import '../sigma.mjs';\nawait import("../tau.mjs");`,
      ),
      [],
    );
  });

  it('bare package and node: specifiers', () => {
    assert.deepEqual(
      importedRelativeLibNames(
        `import 'node:fs';\nimport pkg from 'some-pkg';\nawait import('upsilon');`,
      ),
      [],
    );
  });
});

describe('verifyPackage', () => {
  it('names the script and the undeclared lib for a side-effect import', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'verify-lib-decl-'));
    try {
      const scriptsDir = join(packageDir, 'payload-dist', 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(
        join(scriptsDir, 'run.mjs'),
        `import './lib/phi.mjs';\nimport { c } from './lib/chi.mjs';\n`,
      );
      mkdirSync(join(packageDir, 'src'));
      writeFileSync(
        join(packageDir, 'src', 'index.ts'),
        `api.payload.lib(id, 'chi.mjs');\n`,
      );

      assert.deepEqual(verifyPackage(packageDir), [
        'payload-dist/scripts/run.mjs imports phi.mjs, not declared',
      ]);
    } finally {
      rmSync(packageDir, { recursive: true, force: true });
    }
  });
});
