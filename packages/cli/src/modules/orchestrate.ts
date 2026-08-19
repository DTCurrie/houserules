import type { Action, Answers, ModuleGroup } from '@houserules/api';
import type { Ctx } from '../detect.js';
import { agent, script, skill } from './copy-actions.js';

export const id = 'orchestrate';
export const title = 'Phase execution via scoped workers (/orchestrate)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'drive a planned phase with per-slice sonnet workers — you review reports, not diffs (needs plans)';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * The execution layer for planned phases: the skill plus the task-worker agent it
 * dispatches. The orchestrator slices a phase by file ownership, writes the shared seam
 * itself, fans out one worker per slice in waves, and reviews the returned report rather
 * than the diff. Cost is O(slices x report), and no worker accumulates another slice's
 * context.
 *
 * Script-free, because the value is the slice, seam, wave, and review discipline rather
 * than tooling. It pairs with `plans` but degrades gracefully, sending a user with no
 * plan workspace to /plan-project.
 */
export function plan(ctx: Ctx, answers: Answers): Action[] {
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
    script(
      id,
      'plan-lint.mjs',
      'validate a .claude/plans/ workspace: slice status vocabulary, ROADMAP/sub-plan sync, fix.onSubagentStop, blast-radius artifact shape',
    ),
    {
      kind: 'advise',
      text: withPlans
        ? 'Executing a plan: run /orchestrate [<plan-slug>] [<phase>|all] to drive a .claude/plans/<slug>/ phase — it slices by file ownership, dispatches one sonnet task-worker per slice, and reviews reports instead of diffs. It stops for you between phases unless you pass --auto.'
        : 'Executing a plan: /orchestrate drives a .claude/plans/<slug>/ phase, but the `plans` module is off, so nothing scaffolds those workspaces. Enable it (npx houserules modules --modules=plans) or /orchestrate will just send you to /plan-project.',
      module: id,
    },
  ];
}
