import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const requireFromHere = createRequire(import.meta.url);

const PLUGIN_SCRIPTS = fileURLToPath(
  new URL('../payload-dist/scripts', import.meta.url),
);

const SHARED_LIB_DIR = join(
  dirname(requireFromHere.resolve('@houserules/payload/package.json')),
  'payload-dist/scripts/lib',
);

/**
 * This package's emitted scripts plus the shared libs from `@houserules/payload`, laid out
 * the way the installer lays them out under `.claude/scripts/`.
 *
 * A script that imports `@houserules/payload/config` is emitted with `./lib/config.mjs`,
 * and the plugin's own `payload-dist` never carries that file: install copies it from
 * `@houserules/payload` by reading the sidecar. So a test that spawns a script straight
 * from `payload-dist` fails on module resolution, and has to spawn from here instead.
 * Staged once per test worker when this module loads, and removed when the process exits.
 */
function stageScripts(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-design-scripts-'));
  const staged = join(root, 'scripts');
  cpSync(PLUGIN_SCRIPTS, staged, { recursive: true });
  cpSync(SHARED_LIB_DIR, join(staged, 'lib'), {
    recursive: true,
    filter: (src) => !src.endsWith('.d.mts'),
  });
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  return staged;
}

/** The staged `scripts/` directory, the equivalent of an installed `.claude/scripts/`. */
export const STAGED_SCRIPTS_DIR = stageScripts();

/** `design.mjs` inside {@link STAGED_SCRIPTS_DIR}, the path every spawning test should use. */
export const DESIGN_SCRIPT = join(STAGED_SCRIPTS_DIR, 'design.mjs');
