import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assemblePayload, buildPayload } from '../payload-build.js';
import {
  PAYLOAD_IMPORTS_FILE,
  PAYLOAD_IMPORT_PREFIX,
} from '../payload-imports.js';

const CLI_PACKAGE_DIR = fileURLToPath(new URL('../..', import.meta.url));
const PAYLOAD_PACKAGE_DIR = fileURLToPath(
  new URL('../../../payload', import.meta.url),
);

const roots: string[] = [];

function stageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'payload-build-'));
  roots.push(root);
  return root;
}

function stageCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'payload-build-cwd-'));
  roots.push(cwd);
  mkdirSync(join(cwd, 'node_modules/@houserules'), { recursive: true });
  symlinkSync(
    CLI_PACKAGE_DIR,
    join(cwd, 'node_modules/@houserules/cli'),
    'dir',
  );
  symlinkSync(
    PAYLOAD_PACKAGE_DIR,
    join(cwd, 'node_modules/@houserules/payload'),
    'dir',
  );
  return cwd;
}

function writeAt(root: string, rel: string, body: string): string {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
  return full;
}

function readAt(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('buildPayload', () => {
  it('rewrites a script-root import to a relative lib path', () => {
    const root = stageRoot();
    const cwd = stageCwd();
    writeAt(
      root,
      'scripts/projects-sync.mjs',
      `import { readLog } from '${PAYLOAD_IMPORT_PREFIX}entry-ledger';\n`,
    );

    buildPayload(root, cwd);

    expect(readAt(root, 'scripts/projects-sync.mjs')).toBe(
      "import { readLog } from './lib/entry-ledger.mjs';\n",
    );
  });

  it('rewrites a lib-level import to a relative sibling path', () => {
    const root = stageRoot();
    const cwd = stageCwd();
    writeAt(
      root,
      'scripts/lib/ledger-compaction.mjs',
      `import { readLog } from '${PAYLOAD_IMPORT_PREFIX}entry-ledger';\n`,
    );

    buildPayload(root, cwd);

    expect(readAt(root, 'scripts/lib/ledger-compaction.mjs')).toBe(
      "import { readLog } from './entry-ledger.mjs';\n",
    );
  });

  it('rewrites a bare side-effect import', () => {
    const root = stageRoot();
    const cwd = stageCwd();
    writeAt(
      root,
      'scripts/init.mjs',
      `import '${PAYLOAD_IMPORT_PREFIX}config';\n`,
    );

    buildPayload(root, cwd);

    expect(readAt(root, 'scripts/init.mjs')).toBe(
      "import './lib/config.mjs';\n",
    );
  });

  it('rewrites a dynamic import', () => {
    const root = stageRoot();
    const cwd = stageCwd();
    writeAt(
      root,
      'scripts/lazy.mjs',
      `const mod = await import('${PAYLOAD_IMPORT_PREFIX}config');\n`,
    );

    buildPayload(root, cwd);

    expect(readAt(root, 'scripts/lazy.mjs')).toBe(
      "const mod = await import('./lib/config.mjs');\n",
    );
  });

  it('rewrites an export-from re-export', () => {
    const root = stageRoot();
    const cwd = stageCwd();
    writeAt(
      root,
      'scripts/lib/re-export.mjs',
      `export { readLog } from '${PAYLOAD_IMPORT_PREFIX}entry-ledger';\n`,
    );

    buildPayload(root, cwd);

    expect(readAt(root, 'scripts/lib/re-export.mjs')).toBe(
      "export { readLog } from './entry-ledger.mjs';\n",
    );
  });

  it('records the rewritten lib names in the sidecar keyed by posix-relative path', () => {
    const root = stageRoot();
    const cwd = stageCwd();
    writeAt(
      root,
      'scripts/projects-sync.mjs',
      `import { readLog } from '${PAYLOAD_IMPORT_PREFIX}entry-ledger';\n` +
        `import { loadConfigSafe } from '${PAYLOAD_IMPORT_PREFIX}config';\n`,
    );

    buildPayload(root, cwd);

    const sidecar = JSON.parse(readAt(root, PAYLOAD_IMPORTS_FILE));
    expect(sidecar).toEqual({
      version: 1,
      libs: {
        'scripts/projects-sync.mjs': ['entry-ledger.mjs', 'config.mjs'],
      },
    });
  });

  it('writes an empty sidecar when no file imports a payload lib', () => {
    const root = stageRoot();
    const cwd = stageCwd();
    writeAt(root, 'scripts/plain.mjs', "console.log('hi');\n");

    buildPayload(root, cwd);

    expect(JSON.parse(readAt(root, PAYLOAD_IMPORTS_FILE))).toEqual({
      version: 1,
      libs: {},
    });
  });

  it('produces the same rewrite when a fresh tsc emit is rebuilt', () => {
    const root = stageRoot();
    const cwd = stageCwd();
    const bareSource = `import { readLog } from '${PAYLOAD_IMPORT_PREFIX}entry-ledger';\n`;
    writeAt(root, 'scripts/projects-sync.mjs', bareSource);
    buildPayload(root, cwd);
    const firstPass = readAt(root, 'scripts/projects-sync.mjs');
    const firstSidecar = readAt(root, PAYLOAD_IMPORTS_FILE);

    writeAt(root, 'scripts/projects-sync.mjs', bareSource);
    buildPayload(root, cwd);

    expect(readAt(root, 'scripts/projects-sync.mjs')).toBe(firstPass);
    expect(readAt(root, PAYLOAD_IMPORTS_FILE)).toBe(firstSidecar);
  });

  it('throws naming the file and the unknown lib when a referenced lib does not exist', () => {
    const root = stageRoot();
    const cwd = stageCwd();
    writeAt(
      root,
      'scripts/broken.mjs',
      `import { nope } from '${PAYLOAD_IMPORT_PREFIX}not-a-real-lib';\n`,
    );

    expect(() => buildPayload(root, cwd)).toThrow(
      /broken\.mjs imports unknown lib "not-a-real-lib\.mjs"/,
    );
  });

  it('throws when this pass finds no cross-package imports but the sidecar already lists some', () => {
    const root = stageRoot();
    const cwd = stageCwd();
    writeAt(
      root,
      PAYLOAD_IMPORTS_FILE,
      JSON.stringify({
        version: 1,
        libs: { 'scripts/projects-sync.mjs': ['entry-ledger.mjs'] },
      }),
    );
    writeAt(
      root,
      'scripts/projects-sync.mjs',
      "import { readLog } from './lib/entry-ledger.mjs';\n",
    );

    expect(() => buildPayload(root, cwd)).toThrow(
      /payload-build found no @houserules\/payload\/ imports, but payload-imports\.json already lists 1/,
    );
  });

  it('writes cleanly when the existing sidecar is empty and this pass finds no imports either', () => {
    const root = stageRoot();
    const cwd = stageCwd();
    writeAt(
      root,
      PAYLOAD_IMPORTS_FILE,
      JSON.stringify({ version: 1, libs: {} }),
    );
    writeAt(root, 'scripts/plain.mjs', "console.log('hi');\n");

    buildPayload(root, cwd);

    expect(JSON.parse(readAt(root, PAYLOAD_IMPORTS_FILE))).toEqual({
      version: 1,
      libs: {},
    });
  });
});

describe('assemblePayload', () => {
  it('copies a payload directory into payload-dist under the same name', () => {
    const packageRoot = stageRoot();
    writeAt(packageRoot, 'payload/rules/example.md', '# Example\n');
    const payloadRoot = join(packageRoot, 'payload-dist');

    assemblePayload(payloadRoot, packageRoot);

    expect(readAt(packageRoot, 'payload-dist/rules/example.md')).toBe(
      '# Example\n',
    );
  });

  it('removes a destination file no longer present in the source before copying', () => {
    const packageRoot = stageRoot();
    writeAt(packageRoot, 'payload/rules/keep.md', 'keep\n');
    writeAt(packageRoot, 'payload-dist/rules/stale.md', 'stale\n');
    const payloadRoot = join(packageRoot, 'payload-dist');

    assemblePayload(payloadRoot, packageRoot);

    expect(existsSync(join(packageRoot, 'payload-dist/rules/stale.md'))).toBe(
      false,
    );
  });

  it('excludes a __tests__ directory at any depth under a copied directory', () => {
    const packageRoot = stageRoot();
    writeAt(packageRoot, 'payload/rules/example.md', 'kept\n');
    writeAt(
      packageRoot,
      'payload/rules/__tests__/example.test.md',
      'excluded\n',
    );
    const payloadRoot = join(packageRoot, 'payload-dist');

    assemblePayload(payloadRoot, packageRoot);

    expect(
      existsSync(
        join(packageRoot, 'payload-dist/rules/__tests__/example.test.md'),
      ),
    ).toBe(false);
  });

  it('excludes a legacy __test__ directory so a plugin authored against the old spelling ships no tests', () => {
    const packageRoot = stageRoot();
    writeAt(packageRoot, 'payload/rules/example.md', 'kept\n');
    writeAt(
      packageRoot,
      'payload/rules/__test__/example.test.md',
      'excluded\n',
    );
    const payloadRoot = join(packageRoot, 'payload-dist');

    assemblePayload(payloadRoot, packageRoot);

    expect(
      existsSync(
        join(packageRoot, 'payload-dist/rules/__test__/example.test.md'),
      ),
    ).toBe(false);
  });

  it('leaves scripts untouched, never copying payload/scripts over it', () => {
    const packageRoot = stageRoot();
    writeAt(packageRoot, 'payload/scripts/hook.mts', 'export {};\n');
    writeAt(
      packageRoot,
      'payload-dist/scripts/hook.mjs',
      'export const emitted = true;\n',
    );
    const payloadRoot = join(packageRoot, 'payload-dist');

    assemblePayload(payloadRoot, packageRoot);

    expect(readAt(packageRoot, 'payload-dist/scripts/hook.mjs')).toBe(
      'export const emitted = true;\n',
    );
    expect(existsSync(join(packageRoot, 'payload-dist/scripts/hook.mts'))).toBe(
      false,
    );
  });

  it('throws when payload/scripts has sources but payload-dist/scripts is missing', () => {
    const packageRoot = stageRoot();
    writeAt(packageRoot, 'payload/scripts/hook.mts', 'export {};\n');
    const payloadRoot = join(packageRoot, 'payload-dist');

    expect(() => assemblePayload(payloadRoot, packageRoot)).toThrow(
      /payload-dist\/scripts is missing/,
    );
  });
});

describe('the houserules-payload bin, invoked the way a plugin build invokes it', () => {
  const BIN = join(CLI_PACKAGE_DIR, 'bin/houserules-payload.mjs');

  function runBinIn(cwd: string, payloadRootArg: string) {
    return spawnSync(process.execPath, [BIN, payloadRootArg], {
      cwd,
      encoding: 'utf8',
    });
  }

  it('rewrites and writes the sidecar when run as a child process, not only when imported', () => {
    const cwd = stageCwd();
    mkdirSync(join(cwd, 'payload'), { recursive: true });
    writeAt(
      cwd,
      'payload-dist/scripts/consumer.mjs',
      `import { nowIso } from '${PAYLOAD_IMPORT_PREFIX}entry-ledger';\nconsole.log(nowIso());\n`,
    );

    const result = runBinIn(cwd, 'payload-dist');

    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(readAt(cwd, join('payload-dist', PAYLOAD_IMPORTS_FILE))),
    ).toEqual({
      version: 1,
      libs: { 'scripts/consumer.mjs': ['entry-ledger.mjs'] },
    });
    expect(readAt(cwd, 'payload-dist/scripts/consumer.mjs')).toContain(
      "from './lib/entry-ledger.mjs'",
    );
  });

  it('exits 1 and names the unknown lib rather than writing a sidecar', () => {
    const cwd = stageCwd();
    mkdirSync(join(cwd, 'payload'), { recursive: true });
    writeAt(
      cwd,
      'payload-dist/scripts/consumer.mjs',
      `import { x } from '${PAYLOAD_IMPORT_PREFIX}not-a-real-lib';\nconsole.log(x);\n`,
    );

    const result = runBinIn(cwd, 'payload-dist');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not-a-real-lib');
  });
});
