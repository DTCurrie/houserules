import { KitError } from './plan.js';
import type { Registry } from './plugin-registry.js';

/**
 * Built-in module ids that moved into a plugin package, mapped to the package that now ships
 * them.
 *
 * This exists because of `computePrune`. It deletes every manifest dest the current plan does
 * not produce, so an install that has `backlog` in its manifest, upgraded to a CLI where
 * `backlog` is no longer built in, would plan nothing for it and then delete every file it
 * installed. Silently. The map turns that into an error naming the package to install.
 *
 * Entries are permanent. Removing one re-arms the silent deletion for anyone who skipped a
 * version, and the cost of keeping a line here forever is one line.
 */
export const RETIRED_MODULES: Readonly<Record<string, string>> = {
  backlog: '@agent-kit/plugin-backlog',
  changesets: '@agent-kit/plugin-changesets',
  ledger: '@agent-kit/plugin-changesets',
  decisions: '@agent-kit/plugin-decisions',
  'code-comments': '@agent-kit/plugin-prose',
  'prose-voice': '@agent-kit/plugin-prose',
  'output-prose': '@agent-kit/plugin-prose',
  'terse-style': '@agent-kit/plugin-prose',
  testing: '@agent-kit/plugin-testing',
  'persona-auditor': '@agent-kit/plugin-persona-auditor',
};

/** One retired id and the package that would bring it back. */
export interface RetiredModule {
  id: string;
  packageName: string;
}

/**
 * The retired ids among `moduleIds` that the resolved registry cannot supply.
 *
 * An id is only retired if the registry does NOT have it. A repo that already installed the
 * plugin has the module back, under its namespaced id, and must not be warned about anything.
 * The bare id is what a pre-split manifest recorded, so that is what is matched.
 */
export function findRetired(
  moduleIds: readonly string[],
  registry: Registry,
): RetiredModule[] {
  const seen = new Set<string>();
  const retired: RetiredModule[] = [];
  for (const id of moduleIds) {
    const packageName = RETIRED_MODULES[id];
    if (packageName === undefined) continue;
    if (registry.get(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    retired.push({ id, packageName });
  }
  return retired;
}

/**
 * The fix text for a set of retired modules: which packages to install and what to add to
 * `.claude/kit.config.json`. One line per package, deduplicated, because two retired ids often
 * come from the same package.
 */
export function retiredModuleAdvice(retired: readonly RetiredModule[]): string {
  const byPackage = new Map<string, string[]>();
  for (const entry of retired) {
    const ids = byPackage.get(entry.packageName) ?? [];
    ids.push(entry.id);
    byPackage.set(entry.packageName, ids);
  }
  const lines = [...byPackage].map(
    ([packageName, ids]) =>
      `  ${ids.join(', ')} moved to ${packageName}. Install it, then add ` +
      `{ "name": "${packageName}", "alias": "<alias>" } to the "plugins" array in .claude/kit.config.json.`,
  );
  return lines.join('\n');
}

/**
 * Guards any path that is about to compute a plan from a recorded module set.
 *
 * Call before `computeEffects`, and therefore before `computePrune` can see a plan that is
 * missing a retired module's files. Aborting is the whole point: continuing would look
 * identical to the user having deliberately removed the module.
 *
 * @throws KitError naming every retired module and the package that restores it.
 */
export function assertNoRetiredModules(
  moduleIds: readonly string[],
  registry: Registry,
): void {
  const retired = findRetired(moduleIds, registry);
  if (!retired.length) return;
  throw new KitError(
    `This install uses ${retired.length === 1 ? 'a module' : 'modules'} that moved out of the CLI into ${retired.length === 1 ? 'a plugin' : 'plugins'}:\n` +
      `${retiredModuleAdvice(retired)}\n` +
      'Nothing was changed. Installing the plugin restores the module and its files.',
  );
}
