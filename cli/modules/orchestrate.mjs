// orchestrate module (claude-kit CLI): OPT-IN execution layer for planned phases.
// Ships /orchestrate + the sonnet `task-worker` agent it dispatches: the orchestrator
// slices a phase by FILE OWNERSHIP, writes the shared seam itself, fans out one worker
// per slice in waves, and reviews the returned REPORT — never the diff. Cost is
// O(slices × report), and no worker accumulates the other slices' context.
//
// Script-free: the value is the slice/seam/wave/review discipline, not tooling. Pairs
// with `plans` (it drives .claude/plans/<slug>/ phases and writes the slice table into
// the phase sub-plans) but degrades gracefully — the skill's step 0 sends a user with no
// plan workspace to /plan-project. Same graceful-pairing shape as the `ready` module.

import { skill, agent } from './shared.mjs';

export const id = 'orchestrate';
export const title = 'Phase execution via scoped workers (/orchestrate)';
export const group = 'optional';

export function hint() {
  return 'drive a planned phase with per-slice sonnet workers — you review reports, not diffs (needs plans)';
}

export function defaultEnabled() {
  return false;
}

export function plan(ctx, answers) {
  const withPlans = answers.moduleIds.includes('plans');
  return [
    skill(
      id,
      'orchestrate',
      'slice by file ownership → seam-first → waves of scoped workers → review reports',
    ),
    agent(
      id,
      'task-worker',
      'the sonnet implementer /orchestrate dispatches: one slice, owned paths only, fixed report format',
    ),
    {
      kind: 'advise',
      text: withPlans
        ? 'Executing a plan: run /orchestrate (or /orchestrate all) to drive a .claude/plans/<slug>/ phase — it slices by file ownership, dispatches one sonnet task-worker per slice, and reviews reports instead of diffs. It stops for you between phases unless you pass --auto.'
        : 'Executing a plan: /orchestrate drives a .claude/plans/<slug>/ phase, but the `plans` module is off, so nothing scaffolds those workspaces. Enable it (npx claude-kit modules --modules=plans) or /orchestrate will just send you to /plan-project.',
      module: id,
    },
  ];
}
