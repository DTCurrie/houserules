import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  Action,
  Answers,
  ModuleGroup,
  ModuleOptions,
} from '@houserules/api';
import type { Ctx } from '../detect.js';
import { payloadPath } from '../paths.js';
import { agent, script, skill } from './copy-actions.js';

// The skill() builder copies SKILL.md alone, so the orchestrate skill's supporting
// reference files need their own copy actions or the SKILL.md pointers dangle installed.
const ORCHESTRATE_REFERENCES = [
  'slicing.md',
  'review-patterns.md',
  'fixer-and-residue.md',
  'closing.md',
] as const;

export const id = 'orchestrate';
export const title = 'Phase execution via scoped workers (/orchestrate)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'drive a planned phase with per-slice sonnet workers — you review reports, not diffs (needs plans)';
}

export function defaultEnabled(): boolean {
  return false;
}

const EFFORTS = ['low', 'high', 'xhigh'] as const;
type Effort = (typeof EFFORTS)[number];

export const options: ModuleOptions = {
  prompt:
    'Which task-worker effort variants should install alongside task-worker?',
  choices: [
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
  ],
  defaults: ['low', 'xhigh'],
};

/**
 * Renders one effort variant of `task-worker.md` from its single payload source. Swaps ONLY
 * `name:`, `effort:`, and `description:` in the frontmatter, so `tools:` and `model:` pass
 * through unchanged and the body stays byte-identical. Keeping one source file means a body
 * edit never needs to land in three places.
 */
export function renderTaskWorkerVariant(effort: Effort): string {
  const source = readFileSync(payloadPath('agents', 'task-worker.md'), 'utf8');
  // Search from past the opening delimiter so the file's first line is not the match.
  const frontmatterEnd = source.indexOf('\n---', '---\n'.length);
  const frontmatter = source.slice(0, frontmatterEnd);
  const body = source.slice(frontmatterEnd);

  const rendered = frontmatter
    .replace(/^name: .*$/m, `name: task-worker-${effort}`)
    .replace(/^effort: .*$/m, `effort: ${effort}`)
    .replace(
      /^description: .*$/m,
      `description: Same contract as task-worker at ${effort} effort. Dispatched by /orchestrate with an objective, owned paths, and an acceptance command.`,
    );

  return `${rendered}${body}`;
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
  const chosenEfforts = (answers.moduleOptions[id] ?? []).filter(
    (value): value is Effort => (EFFORTS as readonly string[]).includes(value),
  );
  return [
    skill(
      id,
      'orchestrate',
      'slice by file ownership → seam-first → waves of scoped workers → review reports',
    ),
    ...ORCHESTRATE_REFERENCES.map((name): Action => ({
      kind: 'copy',
      src: join(payloadPath(), 'skills', 'orchestrate', 'references', name),
      dest: `.claude/skills/orchestrate/references/${name}`,
      module: id,
      reason: 'deep-dive reference the orchestrate SKILL.md defers to',
    })),
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
    ...chosenEfforts.map((effort): Action => ({
      kind: 'write',
      dest: `.claude/agents/task-worker-${effort}.md`,
      content: renderTaskWorkerVariant(effort),
      module: id,
      reason: `task-worker effort variant: ${effort}`,
    })),
    {
      kind: 'advise',
      text: withPlans
        ? 'Executing a plan: run /orchestrate [<plan-slug>] [<phase>|all] to drive a .claude/plans/<slug>/ phase — it slices by file ownership, dispatches one sonnet task-worker per slice, and reviews reports instead of diffs. It stops for you between phases unless you pass --auto.'
        : 'Executing a plan: /orchestrate drives a .claude/plans/<slug>/ phase, but the `plans` module is off, so nothing scaffolds those workspaces. Enable it (npx houserules modules --modules=plans) or /orchestrate will just send you to /plan-project.',
      module: id,
    },
  ];
}
