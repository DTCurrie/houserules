// reviewers module (claude-kit CLI): per-target read-only reviewer agents.
// Default OFF and generated as explicit DRAFTs — an agent whose authoritative
// source is an unfilled placeholder is worse than no agent, so the description
// carries a DRAFT marker until the user fills it in (doctor flags leftovers).

import { renderReviewerDraft } from '../render.mjs';

export const id = 'reviewers';
export const title = 'Per-target reviewer agent drafts';
export const group = 'optional';

export function hint(ctx) {
  return `generates DRAFT agents for ${ctx.targets.length || 'your'} target(s) — you fill in the authoritative sources`;
}

export function defaultEnabled() {
  return false;
}

export function plan(ctx, answers) {
  const chosen = answers.reviewerTargets ?? answers.targets.map((t) => t.name);
  const actions = [];
  for (const target of answers.targets) {
    if (!chosen.includes(target.name)) continue;
    actions.push({
      kind: 'seed',
      dest: `.claude/agents/${target.name}-reviewer.md`,
      content: renderReviewerDraft(target),
      module: id,
      reason: `DRAFT reviewer for ${target.label}`,
    });
  }
  if (actions.length) {
    actions.push({
      kind: 'advise',
      text: 'Reviewer agents are DRAFTs: fill in each authoritative source and remove the DRAFT marker (see .claude/agents/*-reviewer.md).',
      module: id,
    });
  }
  return actions;
}
