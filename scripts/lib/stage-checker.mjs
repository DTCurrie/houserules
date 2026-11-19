import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const sharedLibDir = join(
  import.meta.dirname,
  '../../packages/payload/payload-dist/scripts/lib',
);

const LIB_IMPORT = /from\s+['"]\.\/lib\/([\w.-]+\.mjs)['"]/g;
const SIBLING_LIB_IMPORT = /from\s+['"]\.\/([\w.-]+\.mjs)['"]/g;

/** Where a lib named `libName` actually lives: the checker's own package first, then shared. */
function resolveLibSource(packageDir, libName) {
  const local = join(packageDir, 'payload-dist', 'scripts', 'lib', libName);
  if (existsSync(local)) return local;
  const shared = join(sharedLibDir, libName);
  if (existsSync(shared)) return shared;
  return null;
}

/**
 * Every lib a built script needs, transitively, by name. Throws when a lib the source imports
 * cannot be found anywhere, since that is a real build defect a gate should not hide.
 */
function collectLibs(checker) {
  const libs = new Map();
  const queue = [...checker.source.matchAll(LIB_IMPORT)].map((m) => m[1]);
  const visited = new Set(queue);
  while (queue.length > 0) {
    const libName = queue.shift();
    const src = resolveLibSource(checker.packageDir, libName);
    if (!src) {
      throw new Error(
        `${checker.scriptPath} imports ./lib/${libName}, which resolves nowhere`,
      );
    }
    const content = readFileSync(src, 'utf8');
    libs.set(libName, content);
    for (const match of content.matchAll(SIBLING_LIB_IMPORT)) {
      const sibling = match[1];
      if (visited.has(sibling)) continue;
      visited.add(sibling);
      queue.push(sibling);
    }
  }
  return libs;
}

/**
 * Stages a built script plus its libs into a fresh `scripts/` + `scripts/lib/` tree under
 * `stagingRoot`, the flattened shape install produces.
 *
 * @param checker `{ packageDir, scriptPath, source }`, where `packageDir` is the package
 * whose `payload-dist` holds the script.
 * @returns The staged script's path.
 */
export function stageChecker(checker, stagingRoot) {
  const scriptsDir = join(stagingRoot, 'scripts');
  const libDir = join(scriptsDir, 'lib');
  mkdirSync(libDir, { recursive: true });
  const stagedScript = join(scriptsDir, basename(checker.scriptPath));
  writeFileSync(stagedScript, checker.source);
  for (const [libName, content] of collectLibs(checker)) {
    writeFileSync(join(libDir, libName), content);
  }
  return stagedScript;
}
