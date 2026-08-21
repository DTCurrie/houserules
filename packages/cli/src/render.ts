import { claudeMdRegion } from './core/claude-md-region.js';
import { upsertRegion } from '@houserules/api/internal';
import { hasModule } from './plugin-registry.js';
import type { Ctx, PackageManagerInfo, Target } from './detect.js';
import type { Answers } from '@houserules/api';

interface FixDefaults {
  runner: string;
  filterFlag: string;
  runScriptPrefix: string[];
  commands: string[];
}

const DEFAULT_LINTABLE = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'svelte',
  'md',
  'json',
  'css',
  'html',
];

function fixDefaultsFor(
  pm: PackageManagerInfo | null | undefined,
  isMonorepo = true,
): FixDefaults {
  let defaults: FixDefaults;
  switch (pm?.name) {
    case 'pnpm':
      defaults = {
        runner: 'pnpm',
        filterFlag: '--filter',
        runScriptPrefix: ['run'],
        commands: ['lint:fix', 'format:fix'],
      };
      break;
    case 'yarn':
      defaults = {
        runner: 'yarn',
        filterFlag: 'workspace',
        runScriptPrefix: [],
        commands: ['lint:fix', 'format:fix'],
      };
      break;
    case 'bun':
      defaults = {
        runner: 'bun',
        filterFlag: '--filter',
        runScriptPrefix: ['run'],
        commands: ['lint:fix', 'format:fix'],
      };
      break;
    default:
      defaults = {
        runner: 'npm',
        filterFlag: '',
        runScriptPrefix: ['run'],
        commands: ['lint:fix', 'format:fix'],
      };
  }
  // A single-package repo has no workspace to filter into. `<pm> --filter <pkg>
  // <script>` would fail, so clear the filter and run at the root (`<pm> run <script>`).
  if (!isMonorepo) defaults.filterFlag = '';
  return defaults;
}

/**
 * The verify block, which mirrors fix on runner, filter, and prefix but differs on the
 * commands because verify is the read-only gate. Detected per-target `verifyCommands`
 * override the unified default. Only emitted when the verify-changed module is enabled.
 */
export function verifyDefaultsFor(
  pm: PackageManagerInfo | null | undefined,
  isMonorepo = true,
): FixDefaults {
  return { ...fixDefaultsFor(pm, isMonorepo), commands: ['verify'] };
}

/**
 * The `$schema` value that gives editors completion and inline validation on
 * houserules.config.json. The config lives at `.claude/houserules.config.json`, so a local path has to
 * climb out of `.claude/` first. A repo that only ever runs `npx houserules` has no local
 * copy to point at, so it gets the published URL instead of a path resolving to nothing.
 *
 * The dependency probed here is the package name, `@houserules/cli`, not the binary name.
 */
export function schemaRefFor(ctx: Ctx): string {
  const deps = {
    ...ctx.rootPkg?.dependencies,
    ...ctx.rootPkg?.devDependencies,
  };
  return '@houserules/cli' in deps
    ? '../node_modules/@houserules/cli/schema/houserules.config.schema.json'
    : 'https://github.com/DTCurrie/houserules/blob/main/schema/houserules.config.schema.json';
}

/**
 * Seeds `.claude/houserules.config.json` from detected facts. A seeded file is immediately
 * valid JSON, carrying no comments and never a raw placeholder.
 */
export function renderHouseConfig(ctx: Ctx, answers: Answers): string {
  const has = (id: string) => hasModule(answers.moduleIds, id);
  const config: {
    $schema: string;
    version: number;
    packageManager: string;
    fix: FixDefaults & { onSubagentStop: boolean };
    verify?: FixDefaults;
    lintableExtensions: string[];
    generatedFilePattern: string;
    guard: {
      gitCommit: boolean;
      gitPush: boolean;
      gitStash: boolean;
      prCreate: boolean;
      custom: unknown[];
    };
    changesets: { enabled: boolean; stopCheck: boolean; baseBranch: string };
    ledger: { enabled: boolean };
    moduleOptions?: Record<string, string[]>;
    targets: (Pick<
      Target,
      'name' | 'prefix' | 'packageName' | 'pathPrefix' | 'sourcePath' | 'label'
    > & {
      fixCommands?: Target['fixCommands'];
      verifyCommands?: Target['verifyCommands'];
      changelogPath?: string;
      logPath?: string;
    })[];
  } = {
    $schema: schemaRefFor(ctx),
    version: 2,
    packageManager: ctx.packageManager?.name ?? 'npm',
    // onSubagentStop stays false: parallel subagents would each fix every changed
    // package at once, clobbering siblings mid-edit. The parent Stop hook covers it.
    fix: {
      ...fixDefaultsFor(ctx.packageManager, ctx.isMonorepo),
      onSubagentStop: false,
    },
    ...(has('verify-changed')
      ? { verify: verifyDefaultsFor(ctx.packageManager, ctx.isMonorepo) }
      : {}),
    lintableExtensions: DEFAULT_LINTABLE,
    generatedFilePattern: '/(?:CHANGELOG|BACKLOG)\\.md$',
    guard: {
      gitCommit: true,
      gitPush: true,
      gitStash: true,
      prCreate: true,
      custom: [],
    },
    changesets: {
      enabled: has('changesets'),
      stopCheck: has('changesets'),
      baseBranch: ctx.changesets.baseBranch ?? 'main',
    },
    ledger: { enabled: has('ledger') },
    ...(Object.keys(answers.moduleOptions).length
      ? { moduleOptions: answers.moduleOptions }
      : {}),
    targets: answers.targets.map((t) => {
      const target: {
        name: string;
        prefix: string;
        packageName: string;
        pathPrefix: string;
        sourcePath: string;
        label: string;
        fixCommands?: Target['fixCommands'];
        verifyCommands?: Target['verifyCommands'];
        changelogPath?: string;
        logPath?: string;
      } = {
        name: t.name,
        prefix: t.prefix,
        packageName: t.packageName,
        pathPrefix: t.pathPrefix,
        sourcePath: t.sourcePath,
        label: t.label,
      };
      if (t.fixCommands) target.fixCommands = t.fixCommands;
      if (has('verify-changed') && t.verifyCommands)
        target.verifyCommands = t.verifyCommands;
      if (has('ledger')) {
        target.changelogPath = `.claude/changelogs/${t.name}.md`;
        target.logPath = `.claude/changelogs/${t.name}.log`;
      }
      return target;
    }),
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

const INTERESTING_SCRIPTS = [
  'dev',
  'build',
  'check',
  'typecheck',
  'lint',
  'test',
  'verify',
  'fix',
  'format',
  'change',
];

function scriptLines(ctx: Ctx): string[] {
  const scripts = ctx.rootPkg?.scripts ?? {};
  const run =
    ctx.packageManager?.name === 'npm'
      ? 'npm run'
      : (ctx.packageManager?.name ?? 'npm run');
  return INTERESTING_SCRIPTS.filter((s) => scripts[s]).map(
    (s) => `- \`${run} ${s}\``,
  );
}

function changesetsSection(ctx: Ctx, answers: Answers): string[] {
  if (!hasModule(answers.moduleIds, 'changesets')) return [];
  return [
    '### Recording changes (changesets)',
    '',
    'After completing a meaningful change to a package, record a changeset **before the commit**,',
    'via the `/changeset` skill. See that skill for what it does and when to run it.',
    '',
  ];
}

function backlogSection(ctx: Ctx, answers: Answers): string[] {
  if (!hasModule(answers.moduleIds, 'backlog')) return [];
  const prefixes = answers.targets
    .map((t) => `\`${t.prefix}\` (${t.pathPrefix || 'repo root'})`)
    .join(', ');
  return [
    '### Tracking out-of-scope work',
    '',
    'Discover a real issue outside the current scope? **Do not fix it inline.** Log it with the',
    `\`/backlog-add\` skill instead. Prefixes by area: ${prefixes}.`,
    '',
  ];
}

function decisionsSection(ctx: Ctx, answers: Answers): string[] {
  if (!hasModule(answers.moduleIds, 'decisions')) return [];
  return [
    '### Recording decisions',
    '',
    'Settled a design question that the code does not explain on its own? Record it with the',
    '`/decide` skill. See that skill for the bar a decision has to clear and what a record needs.',
    '',
  ];
}

function plansSection(ctx: Ctx, answers: Answers): string[] {
  if (!hasModule(answers.moduleIds, 'plans')) return [];
  return [
    '### Planning large, multi-phase work',
    '',
    'For an implementation too big to hold in one plan, run the `/plan-project` skill. It persists',
    'to `.claude/plans/<name>/`, keeping `ROADMAP.md` current as each phase lands. See the skill',
    'for the full scaffold and when to use it.',
    '',
  ];
}

// /orchestrate is the one sanctioned exception to "no implementation subagents". A
// planned phase's slices are the parallel, bounded work that clause carves out for.
function orchestrateSection(ctx: Ctx, answers: Answers): string[] {
  if (!hasModule(answers.moduleIds, 'orchestrate')) return [];
  return [
    '### Executing a planned phase',
    '',
    'To implement a phase from `.claude/plans/<slug>/`, run `/orchestrate`. See that skill for how',
    'it slices work and reviews it.',
    '',
  ];
}

function subagentExceptionLine(
  answers: Answers,
  { bold = true }: { bold?: boolean } = {},
): string[] {
  if (!hasModule(answers.moduleIds, 'orchestrate')) return [];
  const lead = bold
    ? '- **Exception, a planned phase under `/orchestrate`**:'
    : '- Exception, a planned phase under `/orchestrate`:';
  return [
    `${lead} dispatch one scoped \`task-worker\` per slice`,
    '  and review the returned reports. Never pull a worker’s diff into the main context.',
  ];
}

/** Seeds a whole CLAUDE.md, markers included, for a repo that has none. */
export function renderClaudeMd(ctx: Ctx, answers: Answers): string {
  const name = ctx.rootPkg?.name ?? 'this repo';
  const lines = [
    `# ${name}`,
    '',
    '<!-- TODO: one-line description of the project. Keep this file lean. It is loaded every turn. -->',
    '<!-- For a fuller from-scratch skeleton (layout, scripts, guardrail-doc pointers, per-target',
    '     workflows), see .claude/templates/CLAUDE.md.template, a gitignored reference that',
    '     `npx houserules update` restores if absent. -->',
    '',
    '## Layout',
    '',
    ...answers.targets.map(
      (t) =>
        `- \`${t.pathPrefix || './'}\`: ${t.label}${t.packageName && t.packageName !== '.' ? ` (\`${t.packageName}\`)` : ''}`,
    ),
    '',
  ];
  const scripts = scriptLines(ctx);
  if (scripts.length) {
    lines.push('## Scripts (run from repo root)', '', ...scripts, '');
  }
  // Built with the same upsertRegion call the region action in core.ts uses, so the block
  // this seed writes is always the shape that action finds, rather than a second one.
  const { content: block } = upsertRegion(
    null,
    renderClaudeAdditions(ctx, answers),
    claudeMdRegion,
  );
  lines.push(block.trimEnd(), '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}`;
}

/** The managed-region body spliced into a CLAUDE.md the user already has. */
export function renderClaudeAdditions(ctx: Ctx, answers: Answers): string {
  const body = [
    '### houserules sections',
    '',
    'This block is maintained by `npx houserules update`. Content outside the markers around it',
    'is yours and never touched. For a fuller from-scratch skeleton to compare structure against, see',
    '`.claude/templates/CLAUDE.md.template`, a gitignored reference that `npx houserules update`',
    'restores if absent. For decisions the repo keeps re-deriving on one axis (architecture, API',
    'conventions), instantiate `.claude/templates/rules/GUARDRAIL.md.template` into `.claude/rules/`.',
    '',
    ...changesetsSection(ctx, answers),
    ...backlogSection(ctx, answers),
    ...decisionsSection(ctx, answers),
    ...plansSection(ctx, answers),
    ...orchestrateSection(ctx, answers),
    '### Conventions',
    '',
    '- **The user always handles `git commit` / `push` / PR-create.** Describe what is ready and stop.',
    '  (Enforced by `.claude/scripts/guard-bash.mjs`.)',
    "- **Edit from the file's current bytes.** Re-read before editing when your view of it is",
    "  second-hand (an earlier snapshot, a build or lint error, another tool's output) or the user may",
    "  have it open. A tool's report and the file on disk can disagree within seconds.",
    '- **Do not rewrite what is not yours to change.** When the user presents a file as their own',
    '  finished work, or has it open mid-edit, surface the problem and let them decide.',
    '',
    '### Cost & verification discipline',
    '',
    '- Stage-sized work (≤ a handful of files): implement directly in-context, with no implementation',
    '  subagents. Reserve subagents for genuinely parallel or unbounded work (wide sweeps, migrations).',
    ...subagentExceptionLine(answers, { bold: false }),
    '- Verify with static gates (tests, typecheck, lint) plus a short falsifiable acceptance checklist',
    '  for the user. No browser/screenshot verification unless explicitly asked.',
    '- Run those gates in order: format first, since it rewrites in place and settles the mechanical',
    '  noise, then lint with autofix so only real problems are left, then typecheck and test. Scope',
    '  each command to the packages you changed. This order is for work you do yourself.',
    '  When subagents are editing in parallel, the fixer runs once after they report, never inside',
    '  one of them, since it rewrites files their siblings still have open.',
    '- **"Done" means every check passed, not that the edits were made.** Report a check that failed',
    '  or never ran, with its output. Never claim success over one you did not see pass.',
    '- Derive empirical constants by parsing the artifact itself, not screenshot-and-iterate loops.',
    '- On AskUserQuestion timeout, stop and re-ask later. Never carry tentative selections forward.',
    "- Read the repo's own docs + targeted greps before fanning out Explore/Plan agents.",
    '',
    '### Tool-use efficiency',
    '',
    '- `grep -n` to locate, then `Read` with `offset`/`limit`. Never read big files whole.',
    '- Never `git stash` to baseline-check. Use `git diff --name-only` / `git show HEAD:<path>`.',
    '- Pipe long command output through `grep`, and batch related greps into one call.',
    '',
  ];
  return `${body.join('\n')}`;
}

/**
 * A reviewer agent seeded for one target. User-owned, and deliberately marked DRAFT
 * because an agent with an unfilled authoritative source must not look invocable to the
 * skill router.
 */
export function renderReviewerDraft(target: Target): string {
  return `---
description: "DRAFT: fill in the authoritative source before use. Read-only reviewer for ${target.label} (${target.pathPrefix || 'repo root'})."
name: "${target.name}-reviewer"
tools: Read, Grep, Glob
model: haiku
---

You are the ${target.label} reviewer, a read-only auditor for \`${target.pathPrefix || './'}\`.

<!-- TODO(houserules): this is a DRAFT. Fill in the authoritative source below and delete
     the DRAFT marker from the description above. See the full pattern in
     .claude/templates/agents/reviewer.agent.md.template, a gitignored reference that
     \`npx houserules update\` restores if it's missing. -->

## Authoritative source

\`<path/to/source-of-truth>\`: <why it is authoritative>.

## What you do

1. Read the change under review (diff, file, or description).
2. Read the relevant sections of the authoritative source directly. Never rely on memory.
3. Quote the source verbatim, and cite file paths with line numbers.
4. Return one verdict: **OK** | **Conflict** (quote rule + conflicting code) | **Gap** (source silent).

## Constraints

- Read-only. Describe fixes precisely, and never edit.
- \`grep -n\` to locate, then \`Read\` with \`offset\` + \`limit\`. Never read large files whole.
- Aim for ≤ 8 tool calls. If no verdict by then, return open questions and stop.
`;
}

/** Default `.changeset/config.json`, seeded only when the repo has none. */
export function renderChangesetConfig(ctx: Ctx): string {
  return `${JSON.stringify(
    {
      $schema: 'https://unpkg.com/@changesets/config@3.1.4/schema.json',
      changelog: '@changesets/cli/changelog',
      commit: false,
      fixed: [],
      linked: [],
      access: 'restricted',
      baseBranch:
        ctx.git.branch && ctx.git.branch !== 'HEAD' ? ctx.git.branch : 'main',
      updateInternalDependencies: 'patch',
      ignore: [],
    },
    null,
    2,
  )}\n`;
}
