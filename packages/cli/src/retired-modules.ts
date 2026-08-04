import { KitError } from './plan.js';
import type { RegisteredModule, Registry } from './plugin-registry.js';

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

/**
 * Module ids that were renamed, mapped to the id in use today.
 *
 * Separate from {@link RETIRED_MODULES} because the two answer different questions. That map says
 * which package now ships an id. This one says what the id is now called. `terse-style` needs
 * both, because it was renamed to `output-prose` and moved into a plugin in the same
 * reorganization, so resolving it means applying this map and then looking for a supplier.
 *
 * Entries are permanent, for the reason {@link RETIRED_MODULES} entries are. A recorded id that
 * resolves to nothing is either an error the user cannot act on or a silent prune, depending on
 * which guard sees it first.
 */
export const RENAMED_MODULES: Readonly<Record<string, string>> = {
  'terse-style': 'output-prose',
};

/** The id a recorded module id is known by today, unchanged when it was never renamed. */
function currentId(recordedId: string): string {
  return RENAMED_MODULES[recordedId] ?? recordedId;
}

/** One retired id and the package that would bring it back. */
export interface RetiredModule {
  id: string;
  packageName: string;
}

/**
 * The plugin modules that answer to a bare module id recorded before the plugin split.
 *
 * A pre-split manifest recorded `backlog`. That module now ships from a plugin and registers as
 * `namespacedId(alias, 'backlog')`, so a lookup by the recorded id finds nothing no matter which
 * alias the repo picked. Matching on the module's own `def.id` is what bridges the two, and it
 * is the only bridge available: the alias is the repo's free choice and is not recoverable from
 * the recorded id.
 */
function suppliersOf(
  registry: Registry,
  recordedId: string,
): RegisteredModule[] {
  return registry.modules.filter(
    (module) => module.source !== null && module.def.id === recordedId,
  );
}

/**
 * Rewrites module ids recorded by a pre-split install into the ids the current registry answers
 * to, so a plan built from them addresses the plugin modules that now supply them.
 *
 * Without this, `buildPlan` matches recorded ids against `RegisteredModule.id` and a bare
 * `backlog` matches nothing. The plugin contributes no actions, and `computePrune` then deletes
 * every file it owns because the plan no longer produces them. Opening the retired-module gate
 * without this turns an unfollowable error into silent data loss.
 *
 * An id the registry already answers to is returned unchanged, which also makes this idempotent.
 * An id nothing supplies is returned unchanged so {@link assertNoRetiredModules} still reports it.
 *
 * @throws KitError when two plugins both supply the id, since picking one silently installs the
 * wrong module's files.
 */
export function resolveRecordedModuleIds(
  moduleIds: readonly string[],
  registry: Registry,
): string[] {
  return moduleIds.map((recordedId) => {
    if (registry.get(recordedId)) return recordedId;
    const today = currentId(recordedId);
    if (today !== recordedId && registry.get(today)) return today;
    const suppliers = suppliersOf(registry, today);
    if (suppliers.length === 0) return recordedId;
    if (suppliers.length > 1) {
      throw new KitError(
        `Module "${recordedId}" is supplied by more than one plugin: ` +
          `${suppliers.map((module) => module.id).join(', ')}.\n` +
          'Nothing was changed. Remove one of those plugins from the "plugins" array in ' +
          '.claude/kit.config.json, or rename its alias, so the recorded module resolves to one.',
      );
    }
    return suppliers[0].id;
  });
}

/**
 * The retired ids among `moduleIds` that the resolved registry cannot supply.
 *
 * An id is only retired if nothing in the registry supplies it. A repo that already installed
 * the plugin has the module back, under its namespaced id, and must not be warned about
 * anything. The bare id is what a pre-split manifest recorded, so that is what is matched.
 *
 * The {@link suppliersOf} check is what makes the advice followable. `registry.get` alone asks
 * for the bare id, which a plugin module never registers under, so every wired install was told
 * to install plugins it had already installed and no alias could satisfy it.
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
    const today = currentId(id);
    if (today !== id && registry.get(today)) continue;
    if (suppliersOf(registry, today).length > 0) continue;
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
