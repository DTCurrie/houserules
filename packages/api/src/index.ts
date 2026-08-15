import type { ModuleDef } from './module-def.js';
import type { PayloadBuilders } from './copy-actions.js';

export type {
  Action,
  AdviseAction,
  BodyAction,
  CopyAction,
  FileAction,
  MergeSettingsAction,
  RegionAction,
  SeedAction,
  WriteAction,
} from './actions.js';
export type { Ctx, Target } from './ctx.js';
export type {
  Answers,
  ModuleDef,
  ModuleGroup,
  ModuleOptionChoice,
  ModuleOptions,
} from './module-def.js';
export type {
  HookEntry,
  HookGroup,
  Permissions,
  Settings,
  SettingsFragment,
} from './merge-settings.js';

/**
 * The shapes a module's optional `check(ctx)` returns. Exported because a plugin that ships a
 * health check has to name its return type, and the alternative is a deep import into the
 * CLI's internals or an untyped structural guess.
 */
export type { CheckResult, Finding, Level } from './finding.js';
export type { RegionSpec } from './regions.js';
export type { McpTransport, PayloadBuilders } from './copy-actions.js';

export { hookCommand, hookFragment, scriptPermission } from './hook-wiring.js';

/**
 * `HouseConfig`/`HouseConfigTarget` are contract, not internal, even though houserules' own
 * validator (`parseHouseConfig`, `buildJsonSchema`, ...) is not: `Target` above IS
 * `HouseConfigTarget`, and every plugin's `ctx.claude.houseConfig` is typed `HouseConfig | null`.
 * A plugin that reads either off `Ctx` needs the name to type its own helpers against, the
 * same reason `Ctx` and `Target` are exported. The functions that produce and validate a
 * config file are the installer's job and live in `@houserules/api/internal` instead.
 */
export type { HouseConfig, HouseConfigTarget } from './config.js';

/**
 * What a plugin factory receives. Everything here is bound to the plugin's own package, so a
 * plugin resolves no paths of its own.
 *
 * Deliberately absent: anything that writes. `apply`, `fs-target`, and the plan engine are
 * not reachable from this entry point. A plugin declares actions and houserules decides what
 * they mean against the real tree, which is the invariant the whole dry-run story rests on.
 */
export interface PluginApi {
  /** Action builders rooted at this plugin's `payload-dist/`. */
  payload: PayloadBuilders;
  /** The plugin's own package name, as resolved. Useful in `reason` strings. */
  packageName: string;
  /**
   * The id namespace this plugin's modules are addressed under, from the `alias` in
   * `.claude/houserules.config.json`. A module declaring id `prose-voice` under alias `voice` is
   * selected as `voice/prose-voice`.
   */
  alias: string;
  /**
   * This plugin's slice of `.claude/houserules.config.json`, verbatim and unvalidated. houserules never
   * looks inside it. Validate it yourself and fail loudly, because a plugin that silently
   * accepts a typo'd key is a plugin whose config does nothing.
   */
  config: unknown;
}

/**
 * A plugin's default export. Called once per run, after config is read and before any
 * planning, and returns the modules it contributes.
 *
 * Must be pure. It may read its own package, but it must not touch the target repo, spawn a
 * process, or cache across calls. houserules calls it while computing a plan that may never be
 * applied, including under `--dry-run`.
 *
 * @throws Anything. A plugin that cannot configure itself should throw with a message naming
 *   the config key at fault. houserules reports it and aborts without pruning, because a plugin
 *   that fails to load looks identical to a plugin that retired every file it ever installed.
 */
export type Plugin = (api: PluginApi) => ModuleDef[];

/**
 * Identity helper for a plugin's default export. Adds no behavior. It exists so a plugin
 * written in plain JavaScript still gets the parameter and return types checked.
 */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
