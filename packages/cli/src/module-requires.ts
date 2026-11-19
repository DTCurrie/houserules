import type { ModuleRequirement } from '@houserules/api';

import { HouseError } from './house-error.js';
import { resolveModuleOptions } from './module-options.js';
import type { RegisteredModule, Registry } from './plugin-registry.js';
import { RETIRED_MODULES, retiredModuleAdvice } from './retired-modules.js';

/** A selected module set closed over every requirement it declares. */
export interface RequirementClosure {
  /**
   * The selected registered ids plus every module a requirement pulled in, transitively, in
   * registry order.
   */
  moduleIds: string[];
  /**
   * For each registered id the closure added, the registered id of the module whose
   * requirement pulled it in. A module that was already selected never appears here.
   */
  requiredBy: Record<string, string>;
}

/** Inputs to {@link closeRequirements} beyond the registry and the selected set. */
export interface CloseRequirementsOptions {
  /**
   * Resolves option selections for a module set, so a selected option value's requirements
   * count. Pass `(ids) => resolveModuleOptions(registry, ids, persisted, overrides)`.
   */
  moduleOptions: (moduleIds: string[]) => Record<string, string[]>;
  /** `ctx.packageManager?.name`, for the install command an unmet requirement prints. */
  packageManager?: string;
}

/**
 * Every requirement `module` declares under the given option selection: its own `requires`,
 * then each selected option value's `requires`, in choice order.
 */
export function requirementsOf(
  module: RegisteredModule,
  selectedOptions: readonly string[],
): ModuleRequirement[] {
  const fromChoices = (module.def.options?.choices ?? [])
    .filter((choice) => selectedOptions.includes(choice.value))
    .flatMap((choice) => choice.requires ?? []);
  return [...(module.def.requires ?? []), ...fromChoices];
}

/**
 * The ids a `--modules` value withdraws, each without its leading `-`.
 */
export function withdrawnModuleIds(modulesFlag: string | undefined): string[] {
  return (modulesFlag ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.startsWith('-'))
    .map((token) => token.slice(1));
}

/** What a command's module selection settles to once requirements are closed. */
export interface ClosedSelection {
  closure: RequirementClosure;
  /** Option selections for every module in `closure.moduleIds`, the added ones included. */
  moduleOptions: Record<string, string[]>;
}

/** The option sources and package manager every command closes a selection with. */
export interface SelectionSource {
  /** `moduleOptions` from `.claude/houserules.config.json`. */
  persisted: Record<string, string[]> | undefined;
  /** Selections made this run, by flag or prompt. They win over `persisted`. */
  chosen: Record<string, string[]>;
  /** `ctx.packageManager?.name`. */
  packageManager: string | undefined;
}

/**
 * Closes `moduleIds` over requirements the way every command does, with options resolved by
 * {@link resolveModuleOptions} so a value chosen this run counts and an added module takes its
 * persisted selection or its defaults.
 *
 * @throws HouseError from {@link closeRequirements}.
 */
export function closeSelection(
  registry: Registry,
  moduleIds: readonly string[],
  source: SelectionSource,
): ClosedSelection {
  const optionsFor = (ids: string[]) =>
    resolveModuleOptions(registry, ids, source.persisted, source.chosen);
  const closure = closeRequirements(registry, moduleIds, {
    moduleOptions: optionsFor,
    ...(source.packageManager !== undefined && {
      packageManager: source.packageManager,
    }),
  });
  return { closure, moduleOptions: optionsFor(closure.moduleIds) };
}

/**
 * Closes `moduleIds` over requirements: adds every module a selected module or a selected
 * option value requires, repeating until nothing new is added. A cycle resolves once.
 *
 * A requirement matches a registered module by its bare `def.id`, so it is met under any
 * alias. An already-selected match wins. Otherwise a built-in wins, then a single plugin.
 *
 * @throws HouseError, before any plan exists, when a requirement matches no registered module
 *   (see {@link unmetRequirementMessage}), or when two plugins supply it and neither is selected.
 */
export function closeRequirements(
  registry: Registry,
  moduleIds: readonly string[],
  options: CloseRequirementsOptions,
): RequirementClosure {
  const selected = new Set(moduleIds);
  const requiredBy: Record<string, string> = {};
  let hasAddedModule = true;
  while (hasAddedModule) {
    hasAddedModule = false;
    const resolvedOptions = options.moduleOptions([...selected]);
    for (const module of registry.modules) {
      if (!selected.has(module.id)) continue;
      for (const requirement of requirementsOf(
        module,
        resolvedOptions[module.id] ?? [],
      )) {
        const supplier = pickSupplier(
          registry,
          selected,
          module,
          requirement,
          options.packageManager,
        );
        if (selected.has(supplier.id)) continue;
        selected.add(supplier.id);
        requiredBy[supplier.id] = module.id;
        hasAddedModule = true;
      }
    }
  }
  const registeredIds = new Set(registry.modules.map((module) => module.id));
  return {
    moduleIds: [
      ...registry.modules
        .filter((module) => selected.has(module.id))
        .map((module) => module.id),
      // An id the registry does not know stays, because dropping it lets a later prune delete its files.
      ...moduleIds.filter((id) => !registeredIds.has(id)),
    ],
    requiredBy,
  };
}

/** The registered module that meets `requirement`, preferring one already selected. */
function pickSupplier(
  registry: Registry,
  selected: ReadonlySet<string>,
  requirer: RegisteredModule,
  requirement: ModuleRequirement,
  packageManager: string | undefined,
): RegisteredModule {
  const matches = registry.modules.filter(
    (module) => module.def.id === requirement.id,
  );
  const chosen =
    matches.find((module) => selected.has(module.id)) ??
    matches.find((module) => module.source === null);
  if (chosen) return chosen;
  if (matches.length === 0) {
    throw new HouseError(
      unmetRequirementMessage(requirer.id, requirement, packageManager),
    );
  }
  if (matches.length > 1) {
    throw new HouseError(
      `Module "${requirer.id}" requires "${requirement.id}", which is supplied by more than one plugin: ` +
        `${matches.map((module) => module.id).join(', ')}.\n` +
        'Nothing was changed. Select one of them, or remove one of those plugins from the "plugins" array in ' +
        '.claude/houserules.config.json.',
    );
  }
  return matches[0]!;
}

/**
 * Refuses a withdrawal the closure undid: a withdrawn id that came back because a module
 * still selected requires it.
 *
 * @param withdrawn Registered ids the user withdrew this run, from `--modules -<id>` or
 *   `modules --remove`.
 * @throws HouseError naming both modules, with text exactly:
 *   `Cannot withdraw "<withdrawn>": "<requirer>" requires it. Withdraw "<requirer>" too, or keep "<withdrawn>".\nNothing was changed.`
 */
export function assertNotWithdrawn(
  closure: RequirementClosure,
  withdrawn: readonly string[],
): void {
  for (const id of withdrawn) {
    const requirer = closure.requiredBy[id];
    if (requirer === undefined) continue;
    throw new HouseError(
      `Cannot withdraw "${id}": "${requirer}" requires it. Withdraw "${requirer}" too, or keep "${id}".\nNothing was changed.`,
    );
  }
}

function installCommand(packageManager: string | undefined): string {
  if (packageManager === 'pnpm') return 'pnpm add -D';
  if (packageManager === 'yarn') return 'yarn add -D';
  if (packageManager === 'bun') return 'bun add -d';
  return 'npm install -D';
}

/**
 * The text for a requirement no registered module supplies. One of three forms:
 *
 * - The id is in `RETIRED_MODULES`: `Module "<requirer>" requires "<id>", which moved out of
 *   the CLI into a plugin:\n<retiredModuleAdvice>\nNothing was changed.`
 * - The requirement names a `package`: `Module "<requirer>" requires "<id>", which no
 *   installed plugin supplies.\nInstall it: <install command> <package>\nThen add
 *   { "name": "<package>", "alias": "<alias>" } to the "plugins" array in
 *   .claude/houserules.config.json.\nNothing was changed.`
 * - Neither: `Module "<requirer>" requires "<id>", which no installed plugin supplies and
 *   whose declaration names no package.\nNothing was changed.`
 *
 * The install command follows the package manager: `pnpm add -D`, `yarn add -D`,
 * `bun add -d`, and `npm install -D` for npm or an unknown one.
 */
export function unmetRequirementMessage(
  requirer: string,
  requirement: ModuleRequirement,
  packageManager: string | undefined,
): string {
  const lead = `Module "${requirer}" requires "${requirement.id}", which`;
  const packageName = RETIRED_MODULES[requirement.id];
  if (packageName !== undefined) {
    const advice = retiredModuleAdvice([{ id: requirement.id, packageName }]);
    return `${lead} moved out of the CLI into a plugin:\n${advice}\nNothing was changed.`;
  }
  if (requirement.package === undefined) {
    return `${lead} no installed plugin supplies and whose declaration names no package.\nNothing was changed.`;
  }
  return (
    `${lead} no installed plugin supplies.\n` +
    `Install it: ${installCommand(packageManager)} ${requirement.package}\n` +
    `Then add { "name": "${requirement.package}", "alias": "<alias>" } to the "plugins" array in .claude/houserules.config.json.\n` +
    'Nothing was changed.'
  );
}

/**
 * The plan-output note naming each module the closure added and its requirer, or `null` when
 * it added none. Text exactly: `Added because another module requires it:` then one line per
 * added module, `  <id>, required by <requirer>`, in `closure.moduleIds` order.
 */
export function requiredByNote(closure: RequirementClosure): string | null {
  const lines = closure.moduleIds
    .filter((id) => closure.requiredBy[id] !== undefined)
    .map((id) => `  ${id}, required by ${closure.requiredBy[id]}`);
  if (lines.length === 0) return null;
  return ['Added because another module requires it:', ...lines].join('\n');
}
