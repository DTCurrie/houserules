import type { Action } from './actions.js';
import type { CheckResult } from './finding.js';
import type { Ctx, Target } from './ctx.js';

/**
 * Which section of the interactive multiselect a module appears under.
 * `experimental` is supported by the picker (it prefixes the hint with a warning)
 * but no module currently declares it. Keep it, so shipping one is a one-word change.
 */
export type ModuleGroup = 'recommended' | 'optional' | 'experimental';

/**
 * Another module this one names, by the bare id that module's own `ModuleDef` declares.
 *
 * Bare because the alias is the installing repo's choice: a requirement on `design` is met by
 * `design/design`, `ui/design`, or any other alias that registers it.
 */
export interface ModuleRequirement {
  /** The named module's bare `id`, never alias-qualified. */
  id: string;
  /**
   * The npm package that ships the module, for one that is not built into the CLI. The CLI
   * names it, with its install command, when no installed plugin supplies `id`.
   */
  package?: string;
}

/** One selectable value in a module's option set. */
export interface ModuleOptionChoice {
  value: string;
  label: string;
  hint?: string;
  /**
   * Modules this value cannot work without. Selecting the value installs each one, exactly as
   * a module-level {@link ModuleDef.requires} does. An unselected value requires nothing.
   */
  requires?: ModuleRequirement[];
}

/**
 * A follow-up question asked once a module is enabled, such as which language guides the
 * testing module should install.
 *
 * Declarative DATA, never a callback that prompts. The same declaration drives the
 * interactive picker, the persisted config, and the `--modules` parser, so those three can
 * never disagree about what the valid values are. A module that prompted for itself would be
 * unusable from `--yes`, `update`, and `doctor`, all of which must run non-interactively.
 */
export interface ModuleOptions {
  /** Shown above the multiselect. */
  prompt: string;
  choices: ModuleOptionChoice[];
  /**
   * Chosen when nothing is persisted and nothing was asked, which is every `--yes` run.
   * Without this a non-interactive install of a module with options is undefined.
   */
  defaults: string[];
}

/**
 * Whether `moduleIds` selects the module `bareId` under any alias. A module a plugin ships is
 * selected as `<alias>/<id>`, and the alias is the installing repo's choice, so a plain
 * `includes(bareId)` answers false for every plugin-sourced module. Pass `answers.moduleIds`.
 */
export function hasModule(
  moduleIds: readonly string[],
  bareId: string,
): boolean {
  return moduleIds.some((id) => id === bareId || id.endsWith(`/${bareId}`));
}

/** What the user chose (interactively or via flags). The second module input. */
export interface Answers {
  moduleIds: string[];
  targets: Target[];
  seedChangesetConfig: boolean;
  /**
   * Per-module option selections, keyed by the module id that declared them. Namespaced for
   * a plugin module, so `testing/languages` and `voice/languages` never collide.
   *
   * A module reads its own entry in `plan()`. Absent means the module declared no options,
   * or declared them and the user chose nothing.
   */
  moduleOptions: Record<string, string[]>;
  /**
   * Narrows which targets get a reviewer draft. No caller sets it today. The
   * reviewers module falls back to every target. But it is the module's declared
   * extension point, so it belongs in the seam rather than in a local intersection.
   */
  reviewerTargets?: string[];
  /**
   * Every selected module's {@link ModuleDef.skillTriggers} lines, in registry order. The CLI
   * fills this in before any module's `plan()` runs, and the core module renders it into the
   * managed CLAUDE.md region. A module reads it, never sets it.
   */
  contributedSkillTriggers?: string[];
}

/**
 * A capability unit. Modules are pure: `plan()` decides from `ctx` + `answers` and
 * returns actions. `locked` modules (core) cannot be deselected or disabled.
 */
export interface ModuleDef {
  id: string;
  title: string;
  group: ModuleGroup;
  locked?: boolean;
  /** One-line rationale shown next to the checkbox. */
  hint(ctx: Ctx): string;
  defaultEnabled(ctx: Ctx): boolean;
  /**
   * A follow-up question asked only when this module is enabled. Omit it, which nearly every
   * module does, and the module takes no options at all.
   */
  options?: ModuleOptions;
  /**
   * Modules this one cannot do its job without. Selecting this module installs each of them,
   * transitively, in `init`, the picker, `update`, and `modules`. Withdrawing one while this
   * module stays selected is an error. A requirement no installed plugin supplies stops the
   * run before anything is written.
   */
  requires?: ModuleRequirement[];
  /**
   * Modules this one hands off to when they are installed and correctly skips when they are
   * not. Declaring one installs nothing. It records the dependency so a check can hold the
   * module's prose to it.
   */
  uses?: ModuleRequirement[];
  /**
   * Markdown bullet lines this module adds to the "Skill triggers" section of the managed
   * CLAUDE.md region, already wrapped, or an empty array for none. Called only when the module
   * is selected. Read sibling modules from `answers.moduleIds`, qualified by your plugin's alias.
   */
  skillTriggers?(answers: Answers): string[];
  plan(ctx: Ctx, answers: Answers): Action[];
  /**
   * Health check for an INSTALLED module. Pure and read-only: never writes, spawns, or
   * throws. Returns both the findings doctor should report and the module's readout
   * lines. Doctor decides the severity rollup.
   */
  check?(ctx: Ctx): CheckResult;
}
