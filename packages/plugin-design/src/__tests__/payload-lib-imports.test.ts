import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';

const PLUGIN_DESIGN = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_DESIGN, alias: 'design' }];
const SCRIPTS_DIR = join(PLUGIN_DESIGN, 'payload/scripts');
const LIB_DIR = join(SCRIPTS_DIR, 'lib');
const INDEX_SOURCE = readFileSync(join(PLUGIN_DESIGN, 'src/index.ts'), 'utf8');

function installedLibDir(): string {
  const root = useInstalledRepo('pnpm-monorepo', {
    modules: 'design/design,design/design-tailwind',
    plugins: PLUGINS,
  });

  return join(root, '.claude/scripts/lib');
}

function relativeMjsImportsIn(content: string): string[] {
  const matches = content.matchAll(/from ['"]\.\/(?:lib\/)?([\w-]+)\.mjs['"]/g);

  return [...new Set([...matches].map((match) => match[1]!))];
}

function sourceFileNamesIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.mts'));
}

function declaredLibNames(): string[] {
  const matches = INDEX_SOURCE.matchAll(
    /api\.payload\.lib\(\s*id,\s*'([\w-]+)\.mjs'\s*\)/g,
  );

  return [...new Set([...matches].map((match) => match[1]!))];
}

describe('payload lib imports vs declared libs', () => {
  it('declares a lib for every relative .mjs import in the payload scripts', () => {
    const libDir = installedLibDir();
    const sourceFiles = [
      ...sourceFileNamesIn(SCRIPTS_DIR).map((name) => join(SCRIPTS_DIR, name)),
      ...sourceFileNamesIn(LIB_DIR).map((name) => join(LIB_DIR, name)),
    ];

    const undeclared = sourceFiles.flatMap((path) => {
      const content = readFileSync(path, 'utf8');
      const imports = relativeMjsImportsIn(content);

      return imports
        .filter((name) => !existsSync(join(libDir, `${name}.mjs`)))
        .map((name) => `${path} imports ${name}.mjs`);
    });

    expect(undeclared).toEqual([]);
  });

  it('declares no lib whose source .mts does not exist on disk', () => {
    const missing = declaredLibNames().filter(
      (name) => !existsSync(join(LIB_DIR, `${name}.mts`)),
    );

    expect(missing).toEqual([]);
  });
});
