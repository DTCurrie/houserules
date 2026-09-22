import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  Action,
  Answers,
  CheckResult,
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
  return 'drive a planned phase with per-slice sonnet workers — you review reports, not diffs (needs plans; variants include a research worker)';
}

export function defaultEnabled(): boolean {
  return false;
}

const EFFORTS = ['low', 'high', 'xhigh'] as const;
const VARIANTS = [...EFFORTS, 'research'] as const;
type Variant = (typeof VARIANTS)[number];

export const options: ModuleOptions = {
  prompt:
    'Which task-worker effort variants should install alongside task-worker?',
  choices: [
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
    { value: 'research', label: 'Research (adds WebFetch and WebSearch)' },
  ],
  defaults: ['low', 'xhigh', 'research'],
};

/**
 * Appends any `extraTools` not already on the `tools:` line, in the order given. A name
 * already present, such as `WebFetch` on the research variant, is not repeated. A no-op
 * when `extraTools` is empty, so the byte-identical no-key path never runs this branch.
 */
function appendExtraTools(rendered: string, extraTools: string[]): string {
  if (extraTools.length === 0) return rendered;
  return rendered.replace(/^tools: .*$/m, (line) => {
    const existing = line.slice('tools: '.length).split(', ');
    const missing = extraTools.filter((tool) => !existing.includes(tool));
    return missing.length === 0 ? line : `${line}, ${missing.join(', ')}`;
  });
}

/**
 * Renders `task-worker.md` from its single payload source, with `extraTools` appended to
 * `tools:`. The name, description, effort, and model stay the source's own, so this is the
 * base agent rather than any effort or research variant.
 */
export function renderTaskWorkerBase(extraTools: string[] = []): string {
  const source = readFileSync(payloadPath('agents', 'task-worker.md'), 'utf8');
  return appendExtraTools(source, extraTools);
}

/**
 * Renders one variant of `task-worker.md` from its single payload source. Every variant
 * swaps `name:` and `description:`. An effort variant also swaps `effort:`, leaving `tools:`
 * and `model:` unchanged. The `research` variant instead appends `WebFetch, WebSearch` to
 * `tools:`, leaving `effort:` and `model:` unchanged. `extraTools` is then appended to
 * `tools:` the same way as the base. The body always stays byte-identical, so keeping one
 * source file means a body edit never needs to land in more than one place.
 */
export function renderTaskWorkerVariant(
  variant: Variant,
  extraTools: string[] = [],
): string {
  const source = readFileSync(payloadPath('agents', 'task-worker.md'), 'utf8');
  // Search from past the opening delimiter so the file's first line is not the match.
  const frontmatterEnd = source.indexOf('\n---', '---\n'.length);
  const frontmatter = source.slice(0, frontmatterEnd);
  const body = source.slice(frontmatterEnd);

  const description =
    variant === 'research'
      ? 'Same contract as task-worker, plus WebFetch and WebSearch for a slice that must read a page or source not on disk. Dispatched by /orchestrate with an objective, owned paths, and an acceptance command.'
      : `Same contract as task-worker at ${variant} effort. Dispatched by /orchestrate with an objective, owned paths, and an acceptance command.`;

  let rendered = frontmatter
    .replace(/^name: .*$/m, `name: task-worker-${variant}`)
    .replace(/^description: .*$/m, `description: ${description}`);

  rendered =
    variant === 'research'
      ? rendered.replace(
          /^tools: .*$/m,
          (line) => `${line}, WebFetch, WebSearch`,
        )
      : rendered.replace(/^effort: .*$/m, `effort: ${variant}`);

  rendered = appendExtraTools(rendered, extraTools);

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
  const chosenVariants = (answers.moduleOptions[id] ?? []).filter(
    (value): value is Variant =>
      (VARIANTS as readonly string[]).includes(value),
  );
  const extraTools = ctx.claude?.houseConfig?.orchestrate?.workerTools ?? [];
  const baseAgent: Action =
    extraTools.length === 0
      ? agent(
          id,
          'task-worker',
          'the sonnet implementer /orchestrate dispatches: one slice, owned paths only, fixed report format',
        )
      : {
          kind: 'write',
          dest: '.claude/agents/task-worker.md',
          content: renderTaskWorkerBase(extraTools),
          module: id,
          reason:
            'the sonnet implementer /orchestrate dispatches, with orchestrate.workerTools appended to its tools: line',
        };
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
    baseAgent,
    script(
      id,
      'plan-lint.mjs',
      'validate a .claude/plans/ workspace: slice status vocabulary, ROADMAP/sub-plan sync, fix.onSubagentStop, blast-radius artifact shape',
    ),
    ...chosenVariants.map((variant): Action => ({
      kind: 'write',
      dest: `.claude/agents/task-worker-${variant}.md`,
      content: renderTaskWorkerVariant(variant, extraTools),
      module: id,
      reason: `task-worker variant: ${variant}`,
    })),
    {
      kind: 'advise',
      text: withPlans
        ? 'Executing a plan: run /orchestrate [<plan-slug>] [<phase>|all] to drive a .claude/plans/<slug>/ phase — it slices by file ownership, dispatches one sonnet task-worker per slice (task-worker-research for a slice that must fetch), and reviews reports instead of diffs. It stops for you between phases unless you pass --auto.'
        : 'Executing a plan: /orchestrate drives a .claude/plans/<slug>/ phase, but the `plans` module is off, so nothing scaffolds those workspaces. Enable it (npx houserules modules --modules=plans) or /orchestrate will just send you to /plan-project.',
      module: id,
    },
  ];
}

/**
 * Warns when `orchestrate.workerTools` names a tool that an installed `task-worker*.md`
 * agent's `tools:` line does not carry, so a wave dispatches with a rule-required tool
 * silently missing. Nothing to check when the key is absent or empty. Never throws: an
 * unreadable agent file is skipped rather than failing the whole health check.
 */
export function check(ctx: Ctx): CheckResult {
  const extraTools = ctx.claude?.houseConfig?.orchestrate?.workerTools ?? [];
  if (extraTools.length === 0) return { findings: [], readouts: [] };

  const findings = ctx.claude.agents
    .filter((file) => /^task-worker.*\.md$/.test(file))
    .flatMap((file) => {
      let text: string;
      try {
        text = readFileSync(join(ctx.root, '.claude', 'agents', file), 'utf8');
      } catch {
        return [];
      }

      const toolsLine = text.match(/^tools: .*$/m)?.[0] ?? '';
      const missing = extraTools.filter((tool) => !toolsLine.includes(tool));
      if (missing.length === 0) return [];

      return [
        {
          level: 'WARN' as const,
          msg: `agent ${file} is missing ${missing.join(', ')} from its tools: line — run npx houserules update to refresh it`,
        },
      ];
    });

  return { findings, readouts: [] };
}
