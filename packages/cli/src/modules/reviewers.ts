import { renderReviewerDraft } from '../render.js';
import type { Action, Answers, ModuleGroup } from '@houserules/api';
import type { Ctx } from '../detect.js';
import { script, skill } from './copy-actions.js';

export const id = 'reviewers';
export const title =
  'Per-target reviewer agent drafts + /review-change dispatch';
export const group: ModuleGroup = 'optional';

export function hint(ctx: Ctx): string {
  return `generates DRAFT agents for ${ctx.targets.length || 'your'} target(s). You fill in the authoritative sources`;
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * Per-target read-only reviewer agents, generated as explicit DRAFTs. An agent whose
 * authoritative source is an unfilled placeholder is worse than no agent, so the
 * description carries a DRAFT marker until the user fills it in. Doctor flags leftovers.
 */
export function plan(ctx: Ctx, answers: Answers): Action[] {
  const chosen = answers.reviewerTargets ?? answers.targets.map((t) => t.name);
  const actions: Action[] = [
    // The dispatch recipe. Ships with the module so the drafts are actually wired up.
    skill(
      id,
      'review-change',
      'dispatch per-target reviewers by changed path (OK/Conflict/Gap)',
    ),
    // One file per range, so N reviewers each pay one Read instead of re-deriving the diff.
    script(
      id,
      'review-package.mjs',
      'package a commit range (log, stat, -U10 diff) into one reviewable file',
    ),
  ];
  let reviewers = 0;
  for (const target of answers.targets) {
    if (!chosen.includes(target.name)) continue;
    reviewers += 1;
    actions.push({
      kind: 'seed',
      dest: `.claude/agents/${target.name}-reviewer.md`,
      content: renderReviewerDraft(target),
      module: id,
      reason: `DRAFT reviewer for ${target.label}`,
    });
  }
  if (reviewers) {
    actions.push({
      kind: 'advise',
      text: 'Reviewer agents are DRAFTs: fill in each authoritative source and remove the DRAFT marker, then run /review-change to dispatch them by changed path.',
      module: id,
    });
  }
  return actions;
}
