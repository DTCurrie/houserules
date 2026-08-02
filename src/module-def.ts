import type { Action } from './actions.js';
import type { Ctx, Target } from './detect.js';

/**
 * Which section of the interactive multiselect a module appears under.
 * `experimental` is supported by the picker (it prefixes the hint with a warning)
 * but no module currently declares it. Keep it, so shipping one is a one-word change.
 */
export type ModuleGroup = 'recommended' | 'optional' | 'experimental';

/** What the user chose (interactively or via flags). The second module input. */
export interface Answers {
  moduleIds: string[];
  targets: Target[];
  seedChangesetConfig: boolean;
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
  plan(ctx: Ctx, answers: Answers): Action[];
}
