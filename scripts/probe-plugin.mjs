#!/usr/bin/env node
/**
 * Dev-only tool, never published. Loads one plugin package through the real resolver and prints
 * what it contributes, so a plugin's acceptance is "it actually loads" rather than "it compiles".
 *
 * Usage: `node scripts/probe-plugin.mjs packages/plugin-prose [alias]`
 *
 * Prints one `module <id>` line per contributed module, then one `  <kind> <dest>` line per
 * action that module plans. Exits 1 with the resolver's message if the plugin cannot load, which
 * is the failure a build alone will not catch: a bad entry point, a peer-range mismatch, an id
 * collision, or a payload path pointing outside the package.
 */

import { resolve } from 'node:path';

import { detect } from '../packages/cli/dist/detect.js';
import { buildRegistry } from '../packages/cli/dist/plugin-resolver.js';

const [, , packagePath, aliasArg] = process.argv;
if (!packagePath) {
  console.error('usage: probe-plugin.mjs <package-path> [alias]');
  process.exit(1);
}

const repoRoot = resolve(import.meta.dirname, '..');
const alias = aliasArg ?? 'probe';
const config = {
  version: 2,
  packageManager: 'pnpm',
  targets: [],
  plugins: [{ name: `./${packagePath}`, alias }],
};

const answers = {
  moduleIds: [],
  targets: [],
  seedChangesetConfig: false,
  moduleOptions: {},
};

let registry;
try {
  registry = buildRegistry(repoRoot, config, []);
} catch (error) {
  console.error(`FAILED (${error.name}): ${error.message}`);
  process.exit(1);
}

// The real detector against this repo, not a hand-made fixture. A fake Ctx goes stale the
// moment a module reads a field nobody thought to add, and the failure looks like the
// plugin's fault.
const ctx = detect(repoRoot);

for (const registered of registry.modules) {
  // Every declared option value, so a module gated on options still plans something to inspect.
  const options = registered.def.options;
  if (options) {
    answers.moduleOptions[registered.id] = options.choices.map((c) => c.value);
  }
  console.log(`module ${registered.id}`);
  for (const action of registered.def.plan(ctx, answers)) {
    const target = action.dest ?? action.kind;
    console.log(`  ${action.kind} ${target}`);
    if (!action.src) continue;
    // A plugin's own files resolve inside its own package. A shared lib does not: a plugin
    // that imports one by package name gets a copy derived from `@agent-kit/payload`, the one
    // publish-time source for the six shared libs, and rejecting that here would fail every
    // migrated plugin. The CLI's own payload is also allowed, since the kit's built-in modules
    // (e.g. core) resolve their own non-lib actions there.
    const allowedRoots = [
      resolve(repoRoot, packagePath),
      resolve(repoRoot, 'packages/cli/payload-dist'),
      resolve(repoRoot, 'packages/payload/payload-dist'),
    ];
    if (!allowedRoots.some((allowed) => action.src.startsWith(allowed))) {
      console.error(
        `  !! src escapes the plugin package, the CLI payload, and @agent-kit/payload: ${action.src}`,
      );
      process.exit(1);
    }
  }
}
console.log(`plugins: ${JSON.stringify(registry.plugins)}`);
