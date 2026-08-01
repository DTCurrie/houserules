// reviewers module (claude-kit CLI): per-target read-only reviewer agents.
// Default OFF and generated as explicit DRAFTs — an agent whose authoritative
// source is an unfilled placeholder is worse than no agent, so the description
// carries a DRAFT marker until the user fills it in (doctor flags leftovers).

import { renderReviewerDraft } from '../render.js';
import type { Action, Answers, Ctx, ModuleGroup } from '../types.js';
import { skill } from './shared.js';

export const id = 'reviewers';
export const title =
  'Per-target reviewer agent drafts + /review-change dispatch';
export const group: ModuleGroup = 'optional';

export function hint(ctx: Ctx): string {
  return `generates DRAFT agents for ${ctx.targets.length || 'your'} target(s) — you fill in the authoritative sources`;
}

export function defaultEnabled(): boolean {
  return false;
}

export function plan(ctx: Ctx, answers: Answers): Action[] {
  const chosen = answers.reviewerTargets ?? answers.targets.map((t) => t.name);
  const actions: Action[] = [
    // The dispatch recipe: maps changed paths → each area's reviewer and fans them
    // out read-only. Ships with the module so the reviewer drafts finally get wired
    // up (they were generated but never dispatched before).
    skill(
      id,
      'review-change',
      'dispatch per-target reviewers by changed path (OK/Conflict/Gap)',
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
