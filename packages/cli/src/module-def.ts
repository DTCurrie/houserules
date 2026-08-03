import type { Action } from './actions.js';
import type { CheckResult } from './commands/doctor/finding.js';
import type { Ctx, Target } from './detect.js';

/**
 * Which section of the interactive multiselect a module appears under.
 * `experimental` is supported by the picker (it prefixes the hint with a warning)
 * but no module currently declares it. Keep it, so shipping one is a one-word change.
 */
export type ModuleGroup = 'recommended' | 'optional' | 'experimental';

/** One selectable value in a module's option set. */
export interface ModuleOptionChoice {
  value: string;
  label: string;
  hint?: string;
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
  plan(ctx: Ctx, answers: Answers): Action[];
  /**
   * Health check for an INSTALLED module. Pure and read-only: never writes, spawns, or
   * throws. Returns both the findings doctor should report and the module's readout
   * lines. Doctor decides the severity rollup.
   */
  check?(ctx: Ctx): CheckResult;
}
