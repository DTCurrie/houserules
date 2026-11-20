import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  Action,
  Answers,
  CheckResult,
  Finding,
  ModuleGroup,
  ModuleOptions,
  ModuleRequirement,
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
  'nested.md',
  'milestone.md',
] as const;

export const id = 'orchestrate';
export const title = 'Phase execution via scoped workers (/orchestrate)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'drive a planned phase one layer down: a phase-orchestrator runs per-slice task-workers and you relay its reports, never diffs (installs plans with it; includes a research worker)';
}

export function defaultEnabled(): boolean {
  return false;
}

// The skill sends every codemod-shaped step to /sweep instead of slicing it.
// It also stops without a plan workspace, which only the plans module writes.
export const requires: ModuleRequirement[] = [{ id: 'sweep' }, { id: 'plans' }];

// Modules this one's shipped prose hands off to when installed, and skips or falls back from
// when not. Read by the root `verify:module-references` check.
export const uses: ModuleRequirement[] = [
  { id: 'code-cleanliness' },
  { id: 'ready' },
  { id: 'research' },
  { id: 'lint-fix' },
  { id: 'verify-changed' },
  { id: 'backlog', package: '@houserules/plugin-backlog' },
  { id: 'changesets', package: '@houserules/plugin-changesets' },
  { id: 'decisions', package: '@houserules/plugin-decisions' },
  { id: 'pr-description', package: '@houserules/plugin-prose' },
  { id: 'accessibility-review', package: '@houserules/plugin-accessibility' },
  { id: 'design-review', package: '@houserules/plugin-design' },
];

const VARIANTS = ['research'] as const;
type Variant = (typeof VARIANTS)[number];

export const options: ModuleOptions = {
  prompt: 'Install the research worker alongside task-worker?',
  choices: [
    { value: 'research', label: 'Research (adds WebFetch and WebSearch)' },
  ],
  defaults: ['research'],
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
 * base agent rather than the research variant.
 */
export function renderTaskWorkerBase(extraTools: string[] = []): string {
  const source = readFileSync(payloadPath('agents', 'task-worker.md'), 'utf8');
  return appendExtraTools(source, extraTools);
}

/**
 * Renders the research variant of `task-worker.md` from its single payload source. It swaps
 * `name:` and `description:` and appends `WebFetch, WebSearch` to `tools:`, leaving `effort:`
 * and `model:` unchanged. `extraTools` is then appended to `tools:` the same way as the base.
 * The body stays byte-identical, so a body edit never needs to land in more than one place.
 * Effort is not a variant: `/orchestrate` passes it per dispatch.
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

  const rendered = frontmatter
    .replace(/^name: .*$/m, `name: task-worker-${variant}`)
    .replace(
      /^description: .*$/m,
      'description: Same contract as task-worker, plus WebFetch and WebSearch for a slice that must read a page or source not on disk. Dispatched by /orchestrate with an objective, owned paths, and an acceptance command.',
    )
    .replace(/^tools: .*$/m, (line) => `${line}, WebFetch, WebSearch`);

  return `${appendExtraTools(rendered, extraTools)}${body}`;
}

/**
 * Installs `phase-orchestrator.md`: a plain copy of its payload source with no `extraTools`,
 * otherwise that source written with `extraTools` appended to its `tools:` line, the same
 * rendering `orchestrate.workerTools` gives task-worker.
 */
function phaseOrchestratorAgent(extraTools: string[]): Action {
  const reason =
    'the orchestrator /orchestrate dispatches by default: one phase, its own task-workers, fixed report format';
  if (extraTools.length === 0) return agent(id, 'phase-orchestrator', reason);
  const source = readFileSync(
    payloadPath('agents', 'phase-orchestrator.md'),
    'utf8',
  );
  return {
    kind: 'write',
    dest: '.claude/agents/phase-orchestrator.md',
    content: appendExtraTools(source, extraTools),
    module: id,
    reason: `${reason}, with orchestrate.orchestratorTools appended to its tools: line`,
  };
}

/**
 * The execution layer for planned phases: the skill, the task-worker agent it dispatches,
 * and the phase-orchestrator agent that runs each phase one layer down by default, with
 * `--flat` keeping the single layer at the main conversation. The orchestrator
 * slices a phase by file ownership, writes the shared seam itself, fans out one worker per
 * slice in waves, and reviews the returned report rather than the diff. Cost is
 * O(slices x report), and no worker accumulates another slice's context.
 *
 * Script-free, because the value is the slice, seam, wave, and review discipline rather
 * than tooling. It requires `plans`, which scaffolds the workspaces it drives.
 */
export function plan(ctx: Ctx, answers: Answers): Action[] {
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
          'the implementer /orchestrate dispatches: one slice, owned paths only, fixed report format',
        )
      : {
          kind: 'write',
          dest: '.claude/agents/task-worker.md',
          content: renderTaskWorkerBase(extraTools),
          module: id,
          reason:
            'the implementer /orchestrate dispatches, with orchestrate.workerTools appended to its tools: line',
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
    phaseOrchestratorAgent(
      ctx.claude?.houseConfig?.orchestrate?.orchestratorTools ?? [],
    ),
    script(
      id,
      'plan-lint.mjs',
      'validate a .claude/plans/ workspace: slice status vocabulary, ROADMAP/sub-plan sync, fix.onSubagentStop, blast-radius artifact shape',
    ),
    script(
      id,
      'wave-ceiling.mjs',
      'print the most workers one /orchestrate wave dispatches at once, from the CPU count, the load average, and orchestrate.maxWorkers',
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
      text: 'Executing a plan: run /orchestrate [<plan-slug>] [<phase>|all] to drive a .claude/plans/<slug>/ phase. By default it hands each phase to a phase-orchestrator one layer down, which slices by file ownership, dispatches one task-worker per slice (task-worker-research for a slice that must fetch), and reports back per wave while you relay. /orchestrate <milestone> runs the open step of a milestone. --flat keeps the slicing at the main conversation. It stops for you between phases unless you pass --auto.',
      module: id,
    },
  ];
}

/** Each `orchestrate` key that appends tools, and the installed agent files it appends them to. */
const TOOL_KEYS = [
  { key: 'workerTools', agentFile: /^task-worker.*\.md$/ },
  { key: 'orchestratorTools', agentFile: /^phase-orchestrator\.md$/ },
] as const;

/**
 * Warns when `orchestrate.workerTools` names a tool that an installed `task-worker*.md`
 * agent's `tools:` line does not carry, or `orchestrate.orchestratorTools` one that
 * `phase-orchestrator.md` does not, so a dispatch goes out with a configured tool silently
 * missing. Nothing to check when both keys are absent or empty. Never throws: an unreadable
 * agent file is skipped rather than failing the whole health check.
 */
export function check(ctx: Ctx): CheckResult {
  const orchestrate = ctx.claude?.houseConfig?.orchestrate;
  const findings = TOOL_KEYS.flatMap(({ key, agentFile }) => {
    const tools = orchestrate?.[key] ?? [];
    if (tools.length === 0) return [];
    return ctx.claude.agents
      .filter((file) => agentFile.test(file))
      .flatMap((file) => missingToolsFinding(ctx.root, file, tools));
  });

  return { findings, readouts: [] };
}

/** A WARN naming each of `tools` the installed agent `file` lacks on its `tools:` line, or none when the file is unreadable. */
function missingToolsFinding(
  root: string,
  file: string,
  tools: string[],
): Finding[] {
  let text: string;
  try {
    text = readFileSync(join(root, '.claude', 'agents', file), 'utf8');
  } catch {
    return [];
  }

  const toolsLine = text.match(/^tools: .*$/m)?.[0] ?? '';
  const carried = toolsLine.slice('tools: '.length).split(', ');
  const missing = tools.filter((tool) => !carried.includes(tool));
  if (missing.length === 0) return [];

  return [
    {
      level: 'WARN',
      msg: `agent ${file} is missing ${missing.join(', ')} from its tools: line — run npx houserules update to refresh it`,
    },
  ];
}
