import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { EXIT } from '../cli-contract.js';
import { detect } from '../detect.js';
import { buildRegistry } from '../plugin-resolver.js';
import { PluginResolutionError } from '../plugin-registry.js';

/**
 * Loads one plugin package through the real resolver and reports what it contributes:
 * one `module <id>` line per module, then one indented `<kind> <dest>` line per action
 * that module plans. A payload action whose `src` escapes the plugin's own package
 * directory is reported as a failure, since that is the failure a build alone will not
 * catch.
 *
 * @returns Exit 0 when the plugin loads, exit 1 with the resolver's own message when it
 * does not.
 */
export async function probe(dir: string, alias: string): Promise<number> {
  const packageDir = resolve(dir);
  const config = {
    version: 2 as const,
    packageManager: 'pnpm' as const,
    targets: [],
    plugins: [{ name: packageDir, alias }],
  };

  let registry;
  try {
    registry = buildRegistry(process.cwd(), config, []);
  } catch (error) {
    if (error instanceof PluginResolutionError) {
      console.error(`FAILED (${error.name}): ${error.message}`);
      return EXIT.error;
    }
    throw error;
  }

  const ctx = detect(process.cwd());
  const answers = {
    moduleIds: [],
    targets: [],
    seedChangesetConfig: false,
    moduleOptions: {} as Record<string, string[]>,
  };

  const missing: string[] = [];

  for (const registered of registry.modules) {
    const options = registered.def.options;
    if (options) {
      answers.moduleOptions[registered.id] = options.choices.map(
        (choice) => choice.value,
      );
    }
    console.log(`module ${registered.id}`);
    for (const action of registered.def.plan(ctx, answers)) {
      const target = 'dest' in action ? action.dest : action.kind;
      console.log(`  ${action.kind} ${target}`);
      if ('src' in action && action.src && !action.src.startsWith(packageDir)) {
        console.error(`  !! src escapes the plugin package: ${action.src}`);
        return EXIT.error;
      }
      if ('src' in action && action.src && !existsSync(action.src)) {
        missing.push(action.src);
      }
    }
  }

  if (missing.length) {
    console.error('FAILED: payload file(s) missing:');
    for (const path of missing) console.error(`  ${path}`);
    return EXIT.error;
  }

  return EXIT.ok;
}
