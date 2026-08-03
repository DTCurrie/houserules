import type { KitConfig } from './core/config.js';
import type { ModuleDef } from './module-def.js';

/** Where a plugin came from and what the kit resolved it to. Recorded in the manifest. */
export interface PluginSource {
  /** The `name` from config: an npm package name or a repo-relative path. */
  name: string;
  /** The id namespace its modules are addressed under. */
  alias: string;
  /** From the resolved package.json. `unknown` when it declares none. */
  version: string;
  /** Absolute path to the resolved package directory. */
  dir: string;
}

/**
 * One module in the registry, built-in or contributed.
 *
 * `id` is what the user selects and what the manifest records. For a built-in it is the
 * module's own id. For a plugin module it is `<alias>/<id>`, so two plugins can both ship a
 * module called `rules` without colliding.
 */
export interface RegisteredModule {
  id: string;
  def: ModuleDef;
  /** Null for a built-in. */
  source: PluginSource | null;
}

export interface Registry {
  modules: RegisteredModule[];
  plugins: PluginSource[];
  get(id: string): RegisteredModule | undefined;
}

/**
 * A plugin named in config that could not be loaded, for any reason: unresolvable package,
 * missing entry, peer range mismatch, a factory that threw, or an id collision.
 *
 * Always fatal, and always thrown before any plan is computed. `computePrune` deletes every
 * manifest dest the current plan does not produce, so a plugin that silently failed to load is
 * indistinguishable from a plugin that retired every file it ever installed. There is no safe
 * degraded mode, which is why this is an error and not a warning.
 */
export class PluginResolutionError extends Error {
  /** The `name` from config, so callers can name the package in a fix hint. */
  readonly pluginName: string;

  constructor(pluginName: string, message: string) {
    super(message);
    this.name = 'PluginResolutionError';
    this.pluginName = pluginName;
  }
}

/**
 * Loads the plugins declared in config and returns them alongside the built-ins.
 * Implemented by `plugin-resolver.ts`, which owns the resolution rules.
 *
 * Resolution runs against the TARGET repo, never against the kit's own install. A plugin is a
 * dependency of the repo being configured, the same way an eslint plugin is.
 *
 * Built-ins come first and always win a name contest. A plugin may not claim a bare id, and
 * two plugins may not share an alias. Both are {@link PluginResolutionError}.
 *
 * `builtIns` is passed in rather than imported, so the resolver stays free of the module list
 * it populates and a test can build a registry from a fixture set.
 */
export type BuildRegistry = (
  root: string,
  config: KitConfig | null,
  builtIns: ModuleDef[],
) => Registry;

/**
 * Wraps a bare module id in its plugin's namespace. Built-in ids are returned unchanged, which
 * is why `alias` is nullable: one call site handles both kinds without branching.
 */
export function namespacedId(alias: string | null, moduleId: string): string {
  return alias === null ? moduleId : `${alias}/${moduleId}`;
}
