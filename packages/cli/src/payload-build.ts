import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import {
  PAYLOAD_IMPORT_PREFIX,
  PAYLOAD_IMPORTS_FILE,
  readPayloadImports,
  type PayloadImports,
} from './payload-imports.js';

/** Every prefix the rewriter recognizes, tried in order. */
const RECOGNIZED_PREFIXES = [PAYLOAD_IMPORT_PREFIX];

const FROM_SPECIFIER =
  /((?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"])([^'"]+)(['"])/g;
const DYNAMIC_SPECIFIER = /(\bimport\s*\(\s*['"])([^'"]+)(['"]\s*\))/g;
const BARE_SPECIFIER = /((?:^|\n)\s*import\s+['"])([^'"]+)(['"])/g;

function walkMjsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory()
      ? walkMjsFiles(full)
      : full.endsWith('.mjs')
        ? [full]
        : [];
  });
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function relativeLibSpecifier(
  fileDir: string,
  payloadRoot: string,
  libName: string,
): string {
  const target = join(payloadRoot, 'scripts', 'lib', `${libName}.mjs`);
  const rel = toPosix(relative(fileDir, target));
  return rel.startsWith('.') ? rel : `./${rel}`;
}

interface RewriteResult {
  source: string;
  changed: boolean;
  libs: string[];
}

function rewriteImports(
  source: string,
  fileDir: string,
  payloadRoot: string,
): RewriteResult {
  const seen = new Set<string>();
  let changed = false;

  const replace = (text: string, pattern: RegExp): string =>
    text.replace(
      pattern,
      (match, prefix: string, spec: string, suffix: string) => {
        const matchedPrefix = RECOGNIZED_PREFIXES.find((candidate) =>
          spec.startsWith(candidate),
        );
        if (!matchedPrefix) return match;
        const libName = spec.slice(matchedPrefix.length);
        // The sidecar records the emitted BASENAME, extension included, because a consumer builds
        // an install destination straight from it as `.claude/scripts/lib/<name>`. Recording the
        // bare specifier tail instead produced an extensionless copy that resolved to nothing.
        seen.add(`${libName}.mjs`);
        changed = true;
        return `${prefix}${relativeLibSpecifier(fileDir, payloadRoot, libName)}${suffix}`;
      },
    );

  let rewritten = source;
  rewritten = replace(rewritten, FROM_SPECIFIER);
  rewritten = replace(rewritten, DYNAMIC_SPECIFIER);
  rewritten = replace(rewritten, BARE_SPECIFIER);

  return { source: rewritten, changed, libs: [...seen] };
}

/** Top-level `payload/` directories a plugin never wants copied verbatim into `payload-dist/`. */
const SKIP_TOP_LEVEL_DIRS = new Set(['scripts', '__test__']);

function isUnderTestDir(relativePath: string): boolean {
  return relativePath.split(sep).includes('__test__');
}

/**
 * Copies every `payload/<dir>` except `scripts` into `payload-dist/<dir>`, replacing whatever
 * was there. One entry per directory present under `payload/`, not a hand-listed set,
 * so a plugin adding a new surface directory ships without editing a build script
 * (AGENTKIT-b947e5).
 *
 * `scripts` is not copied here. `tsconfig.payload.json` compiles `payload/scripts/*.mts`
 * straight into `payload-dist/scripts`, so this function only asserts that output already
 * exists rather than duplicating it, and never touches it.
 *
 * `__test__` directories are excluded at any depth under a copied directory, mirroring
 * `tsconfig.payload.json`'s own `payload/**\/__test__/**` exclude for the scripts it compiles.
 * A colocated test must never reach the published package, whichever surface it sits under.
 *
 * @throws When `payload/scripts` has sources but `payload-dist/scripts` is missing, meaning
 *   `tsc -p tsconfig.payload.json` has not run yet.
 */
export function assemblePayload(
  payloadRoot: string,
  packageRoot: string,
): void {
  const source = join(packageRoot, 'payload');
  if (!existsSync(source)) {
    throw new Error(`${source} is missing — nothing to assemble.`);
  }
  mkdirSync(payloadRoot, { recursive: true });

  if (
    existsSync(join(source, 'scripts')) &&
    !existsSync(join(payloadRoot, 'scripts'))
  ) {
    throw new Error(
      `${join(payloadRoot, 'scripts')} is missing — run \`tsc -p tsconfig.payload.json\` first.`,
    );
  }

  const dirs = readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !SKIP_TOP_LEVEL_DIRS.has(name));

  for (const dir of dirs) {
    const from = join(source, dir);
    const to = join(payloadRoot, dir);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, {
      recursive: true,
      filter: (candidate) => !isUnderTestDir(relative(from, candidate)),
    });
  }
}

/** Resolves the directory a plugin's build should verify its rewritten lib imports against. */
function payloadLibDir(cwd: string): string {
  const require = createRequire(join(cwd, 'package.json'));
  const payloadPackageJson =
    require.resolve('@houserules/payload/package.json');
  return join(dirname(payloadPackageJson), 'payload-dist', 'scripts', 'lib');
}

/**
 * Rewrites every cross-package payload import under `payloadRoot` to the relative form the
 * flattened runtime layout needs, and writes the `payload-imports.json` sidecar recording what
 * it rewrote.
 *
 * @throws When a rewritten file references a lib that does not exist in
 *   `@houserules/payload`'s `payload-dist/scripts/lib/`.
 */
/**
 * Checks every rewrite against the libs `@houserules/payload` actually ships, and against
 * the sidecar already on disk, before anything is written.
 *
 * @throws When a rewritten file references a lib that does not exist in
 *   `@houserules/payload`'s `payload-dist/scripts/lib/`, or when the emitted output looks
 *   stale (no `@houserules/payload` imports found, but the existing sidecar lists some).
 */
function validateRewrites(
  payloadRoot: string,
  rewrites: Map<string, RewriteResult>,
  cwd: string,
): PayloadImports['libs'] {
  const hasLibImports = [...rewrites.values()].some(
    (result) => result.libs.length > 0,
  );
  // Only a plugin that imports a shared lib needs `@houserules/payload` resolvable, so
  // this stays unresolved for the common case of a plugin with none.
  const libDir = hasLibImports ? payloadLibDir(cwd) : undefined;

  const missing: string[] = [];
  for (const [file, result] of rewrites) {
    for (const libName of result.libs) {
      if (!libDir || !existsSync(join(libDir, libName))) {
        missing.push(
          `${toPosix(relative(payloadRoot, file))} imports unknown lib "${libName}"`,
        );
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `payload-build found imports of libs that do not exist in @houserules/payload:\n${missing.join('\n')}`,
    );
  }

  const libs: PayloadImports['libs'] = {};
  for (const [file, result] of rewrites) {
    if (result.libs.length === 0) continue;
    libs[toPosix(relative(payloadRoot, file))] = result.libs;
  }

  const existing = readPayloadImports(payloadRoot);
  const foundNothing = Object.keys(libs).length === 0;
  const existingHadLibs = Object.keys(existing.libs).length > 0;
  if (foundNothing && existingHadLibs) {
    const count = Object.keys(existing.libs).length;
    throw new Error(
      `payload-build found no ${PAYLOAD_IMPORT_PREFIX} imports, but ${PAYLOAD_IMPORTS_FILE} already lists ${count}. ` +
        'Emitted output looks stale. Re-run tsc before this tool.',
    );
  }

  return libs;
}

export function buildPayload(payloadRoot: string, cwd: string): void {
  const files = walkMjsFiles(payloadRoot);

  const rewrites = new Map<string, RewriteResult>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const result = rewriteImports(source, dirname(file), payloadRoot);
    rewrites.set(file, result);
  }

  const libs = validateRewrites(payloadRoot, rewrites, cwd);

  for (const [file, result] of rewrites) {
    if (result.changed) writeFileSync(file, result.source);
  }

  const sidecar: PayloadImports = { version: 1, libs };
  writeFileSync(
    join(payloadRoot, PAYLOAD_IMPORTS_FILE),
    JSON.stringify(sidecar, null, 2) + '\n',
  );
}

/** The default payload root, relative to the package the tool is run from. */
export const DEFAULT_PAYLOAD_ROOT = 'payload-dist';
