#!/usr/bin/env node
/**
 * Assembles payload-dist/, the tree that ships and gets copied into user repos. `.mts`
 * sources are compiled by tsconfig.payload.json, which runs before this. Everything else
 * under payload/ is prose and is copied through verbatim, one entry per directory actually
 * present under payload/ rather than a hand-listed set, so a new surface directory ships
 * without this file changing (AGENTKIT-b947e5).
 *
 * This is the one package whose own assembly step cannot call the shared `assemblePayload`/
 * `buildPayload` (`src/payload-build.ts`, exposed as the `agent-kit-payload` bin): that
 * function only exists once cli's OWN `dist/` is built, and this script runs before that, as
 * part of building it. Every other package calls the bin instead, because their build depends
 * on cli already being fully built. This is the one intentional duplicate of that logic,
 * covering both the directory copy AND the `@agent-kit/payload/<lib>` import rewrite, since
 * this package's own hook scripts (guard-bash.mts and friends) now reach the shared libs the
 * same way a plugin does.
 *
 * `@agent-kit/payload` is the one PUBLISH-time source for the six libs now: the CLI's own
 * `.claude/scripts/lib/*.mjs` copy actions (`src/modules/core.ts`) resolve straight there, and
 * so does a plugin's sidecar-derived copy (`src/modules/copy-actions.ts`), and `package.json`'s
 * `files` excludes `payload-dist/scripts/lib/**` so the published tarball carries none of them.
 * A local copy still lands under `payload-dist/scripts/lib/` here, byte-identical to
 * `@agent-kit/payload`'s own build: this package's own compiled hook scripts (guard-bash.mjs
 * and friends) resolve `./lib/<name>.mjs` relative to their own real path, on bare node, which
 * is what lets `payload/__test__/execution.test.ts` and the per-script `payload/scripts/__test__/`
 * suites run them straight out of this package's build output without an install step, and it
 * is what keeps a plugin still on `LEGACY_PAYLOAD_IMPORT_PREFIX` typechecking against this
 * package's `./payload/*` compatibility export.
 *
 * One root, not two, for what SHIPS. `src/paths.ts` resolves `payloadPath()` to payload-dist,
 * so the installer never reads a half-built mixture of sources and output.
 */

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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(ROOT, 'payload');
const OUT = join(ROOT, 'payload-dist');

if (!existsSync(join(OUT, 'scripts'))) {
  console.error(
    'payload-dist/scripts is missing — run `tsc -p tsconfig.payload.json` first.',
  );
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

function isUnderTestDir(relativePath) {
  return relativePath.split(sep).includes('__test__');
}

const dirs = readdirSync(SOURCE, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => name !== 'scripts' && name !== '__test__');

for (const dir of dirs) {
  const from = join(SOURCE, dir);
  const to = join(OUT, dir);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, {
    recursive: true,
    filter: (candidate) => !isUnderTestDir(relative(from, candidate)),
  });
}

/**
 * Copies the compiled libs (`.mjs` + `.d.mts`) out of `@agent-kit/payload`'s own
 * `payload-dist/scripts/lib/`, resolved by package name rather than a relative path into a
 * sibling package. `package.json`'s `files` excludes this directory from what gets published,
 * so the bytes exist here for this package's own build/test needs only, never for shipping.
 */
function copyPayloadLibs() {
  const require = createRequire(import.meta.url);
  const payloadPackageJson = require.resolve('@agent-kit/payload/package.json');
  const sourceLibDir = join(
    dirname(payloadPackageJson),
    'payload-dist',
    'scripts',
    'lib',
  );
  const destLibDir = join(OUT, 'scripts', 'lib');
  rmSync(destLibDir, { recursive: true, force: true });
  mkdirSync(destLibDir, { recursive: true });
  for (const name of readdirSync(sourceLibDir)) {
    cpSync(join(sourceLibDir, name), join(destLibDir, name));
  }
  return destLibDir;
}

function walkMjsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory()
      ? walkMjsFiles(full)
      : full.endsWith('.mjs')
        ? [full]
        : [];
  });
}

function toPosix(path) {
  return path.split(sep).join('/');
}

/**
 * Rewrites every `@agent-kit/payload/<lib>` import under `payload-dist/scripts` (this
 * package's own hook scripts) to the relative form the flattened install layout needs. The
 * lib copies `copyPayloadLibs` places make every such reference resolvable, both here and once
 * `agent-kit init` places the script and its lib sibling at the matching spot in a target repo.
 */
function rewritePayloadLibImports(libDir) {
  const scriptsDir = join(OUT, 'scripts');
  for (const file of walkMjsFiles(scriptsDir)) {
    if (dirname(file) === libDir) continue;
    const source = readFileSync(file, 'utf8');
    const rewritten = source.replace(
      /(from\s+['"])@agent-kit\/payload\/([^'"]+)(['"])/g,
      (match, prefix, libName, suffix) => {
        const target = join(libDir, `${libName}.mjs`);
        const rel = toPosix(relative(dirname(file), target));
        return `${prefix}${rel.startsWith('.') ? rel : `./${rel}`}${suffix}`;
      },
    );
    if (rewritten !== source) writeFileSync(file, rewritten);
  }
}

const libDir = copyPayloadLibs();
rewritePayloadLibImports(libDir);

console.log(
  `Assembled payload-dist (${dirs.join(', ')} + compiled scripts, libs from @agent-kit/payload, excluded from the published tarball)`,
);
