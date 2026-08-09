import { createRequire } from 'node:module';
import {
  existsSync,
  readdirSync,
  readFileSync,
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
        if (!spec.startsWith(PAYLOAD_IMPORT_PREFIX)) return match;
        const libName = spec.slice(PAYLOAD_IMPORT_PREFIX.length);
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

function cliLibDir(cwd: string): string {
  const require = createRequire(join(cwd, 'package.json'));
  const cliPackageJson = require.resolve('@agent-kit/cli/package.json');
  return join(dirname(cliPackageJson), 'payload-dist', 'scripts', 'lib');
}

/**
 * Rewrites every cross-package payload import under `payloadRoot` to the relative form the
 * flattened runtime layout needs, and writes the `payload-imports.json` sidecar recording what
 * it rewrote.
 *
 * @throws When a rewritten file references a lib that does not exist in the CLI's own
 *   `payload-dist/scripts/lib/`.
 */
export function buildPayload(payloadRoot: string, cwd: string): void {
  const files = walkMjsFiles(payloadRoot);
  const libDir = cliLibDir(cwd);

  const rewrites = new Map<string, RewriteResult>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const result = rewriteImports(source, dirname(file), payloadRoot);
    rewrites.set(file, result);
  }

  const missing: string[] = [];
  for (const [file, result] of rewrites) {
    for (const libName of result.libs) {
      if (!existsSync(join(libDir, libName))) {
        missing.push(
          `${toPosix(relative(payloadRoot, file))} imports unknown lib "${libName}"`,
        );
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `payload-build found imports of libs that do not exist in @agent-kit/cli:\n${missing.join('\n')}`,
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
