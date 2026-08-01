// Generators for the user-owned files init seeds (claude-kit CLI): kit.config.json,
// CLAUDE.md (when absent), CLAUDE.additions.md (when present), reviewer drafts.
// Seeded files are filled with DETECTED facts — a seeded file must be immediately
// valid, with at most <!-- TODO --> comments, never raw <PLACEHOLDER>s.

import type { Answers, Ctx, PackageManagerInfo, Target } from './types.js';

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
  // A single-package repo has no workspace to filter into — `<pm> --filter <pkg>
  // <script>` would fail, so clear the filter and run at the root (`<pm> run <script>`).
  if (!isMonorepo) defaults.filterFlag = '';
  return defaults;
}

// The verify block mirrors fix (same runner/filter/prefix), but the read-only gate
// commands differ — a unified `verify` script by default; per-target verifyCommands
// (detected) override it. Only emitted when the verify-changed module is enabled.
export function verifyDefaultsFor(
  pm: PackageManagerInfo | null | undefined,
  isMonorepo = true,
): FixDefaults {
  return { ...fixDefaultsFor(pm, isMonorepo), commands: ['verify'] };
}

// `$schema` gives editors completion + inline validation on kit.config.json. The
// config lives at `.claude/kit.config.json`, so a local path has to climb out of
// `.claude/` first. A repo that only ever runs `npx claude-kit` has no local copy to
// point at, so those get the published URL instead of a path that resolves to nothing.
export function schemaRefFor(ctx: Ctx): string {
  const deps = {
    ...ctx.rootPkg?.dependencies,
    ...ctx.rootPkg?.devDependencies,
  };
  return 'claude-kit' in deps
    ? '../node_modules/claude-kit/schema/kit.config.schema.json'
    : 'https://github.com/devintcurrie/claude-kit/schema/kit.config.schema.json';
}

export function renderKitConfig(ctx: Ctx, answers: Answers): string {
  const has = (id: string) => answers.moduleIds.includes(id);
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
    // onSubagentStop stays false: parallel subagents (an /orchestrate wave, /sweep
    // shards) would each fix every changed package at once, clobbering siblings
    // mid-edit. The parent turn's Stop hook covers the same ground once.
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
  if (!answers.moduleIds.includes('changesets')) return [];
  return [
    '### Recording changes (changesets)',
    '',
    'After completing a meaningful change to a package, record a changeset **before the commit**',
    '— run the `/changeset` skill (or spawn the `changeset-writer` agent). It inspects the diff,',
    'picks patch/minor/major per package, and writes `.changeset/*.md` via',
    '`node .claude/scripts/changeset-write.mjs`. Never hand-edit `CHANGELOG.md` — releases',
    'generate it from changesets (`changeset version`). If nothing user-facing changed, record',
    'that too: `node .claude/scripts/changeset-write.mjs --empty --summary "<why no release>"`.',
    '',
  ];
}

function backlogSection(ctx: Ctx, answers: Answers): string[] {
  if (!answers.moduleIds.includes('backlog')) return [];
  const prefixes = answers.targets
    .map((t) => `\`${t.prefix}\` (${t.pathPrefix || 'repo root'})`)
    .join(', ');
  return [
    '### Tracking out-of-scope work',
    '',
    'Discover a real issue outside the current scope? **Do not fix it inline** — log it and move on:',
    'run the `/backlog-add` skill (backed by `node .claude/scripts/backlog-log.mjs`).',
    `Prefixes by area: ${prefixes}.`,
    'On resolving an item while shipping, remove it: `node .claude/scripts/backlog-log.mjs remove <ID> <file> "<resolution>"`.',
    '',
  ];
}

function plansSection(ctx: Ctx, answers: Answers): string[] {
  if (!answers.moduleIds.includes('plans')) return [];
  return [
    '### Planning large, multi-phase work',
    '',
    'For an implementation too big to hold in one plan (3+ independently-landing phases, or work',
    'you expect to pause and resume), run the `/plan-project` skill. It persists the plan to a gitignored',
    '`.claude/plans/<name>/` workspace — a `PLAN.md` overview, a living `ROADMAP.md`, and one',
    'sub-plan per phase — and keeps ROADMAP status current in place as each phase lands.',
    '**Resuming such work?** Read `.claude/plans/<name>/ROADMAP.md` first for live status; grep its',
    'status lines instead of re-deriving scope from the transcript.',
    '',
  ];
}

// /orchestrate is the one sanctioned exception to "no implementation subagents": a
// planned phase's slices are the parallel, bounded work that clause carves out for.
function orchestrateSection(ctx: Ctx, answers: Answers): string[] {
  if (!answers.moduleIds.includes('orchestrate')) return [];
  return [
    '### Executing a planned phase',
    '',
    'To implement a phase from `.claude/plans/<slug>/`, run `/orchestrate [<plan-slug>] [<phase>|all]`',
    '(the slug is optional when only one plan is live; it stops between phases unless you pass `--auto`).',
    'It slices the phase by **file ownership**, writes the shared seam first, dispatches one `task-worker`',
    'subagent per slice in waves, and reviews each worker’s **report** — never its diff. Workers never run',
    'lint/format/fix; the orchestrator does that once per wave, after every worker has reported.',
    '',
  ];
}

function subagentExceptionLine(
  answers: Answers,
  { bold = true }: { bold?: boolean } = {},
): string[] {
  if (!answers.moduleIds.includes('orchestrate')) return [];
  const lead = bold
    ? '- **Exception — a planned phase under `/orchestrate`**:'
    : '- Exception — a planned phase under `/orchestrate`:';
  return [
    `${lead} dispatch one scoped \`task-worker\` per slice`,
    '  and review the returned reports; never pull a worker’s diff into the main context.',
  ];
}

export function renderClaudeMd(ctx: Ctx, answers: Answers): string {
  const name = ctx.rootPkg?.name ?? 'this repo';
  const lines = [
    `# ${name}`,
    '',
    '<!-- TODO: one-line description of the project. Keep this file lean — it is loaded every turn. -->',
    '<!-- For a fuller from-scratch skeleton (layout, scripts, guardrail-doc pointers, per-target',
    '     workflows), see .claude/kit-templates/CLAUDE.md.template — a gitignored reference that',
    '     `npx claude-kit update` restores if absent. -->',
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
  // Baked in the same shape `upsertRegion` produces (start, blank, body, blank, end),
  // so the region action core.ts plans right after this seed finds the markers
  // already present and matching, rather than a second, discarded insertion.
  lines.push(
    '<!-- claude-kit:claude-md start -->',
    '',
    renderClaudeAdditions(ctx, answers).trimEnd(),
    '',
    '<!-- claude-kit:claude-md end -->',
    '',
  );
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}`;
}

export function renderClaudeAdditions(ctx: Ctx, answers: Answers): string {
  const body = [
    '### claude-kit sections',
    '',
    'This block is maintained by `npx claude-kit update` — content outside the markers around it',
    'is yours and never touched. For a fuller from-scratch skeleton to compare structure against, see',
    '`.claude/kit-templates/CLAUDE.md.template` (a gitignored reference; `npx claude-kit update`',
    'restores it if absent).',
    '',
    ...changesetsSection(ctx, answers),
    ...backlogSection(ctx, answers),
    ...plansSection(ctx, answers),
    ...orchestrateSection(ctx, answers),
    '### Conventions',
    '',
    '- **The user always handles `git commit` / `push` / PR-create.** Describe what is ready and stop.',
    '  (Enforced by `.claude/scripts/guard-bash.mjs`.)',
    '',
    '### Cost & verification discipline',
    '',
    '- Stage-sized work (≤ a handful of files): implement directly in-context; no implementation',
    '  subagents. Reserve subagents for genuinely parallel or unbounded work (wide sweeps, migrations).',
    ...subagentExceptionLine(answers, { bold: false }),
    '- Verify with static gates (tests, typecheck, lint) + a short falsifiable acceptance checklist for',
    '  the user; no browser/screenshot verification unless explicitly asked.',
    '- Derive empirical constants by parsing the artifact itself, not screenshot-and-iterate loops.',
    '- On AskUserQuestion timeout, stop and re-ask later — never carry tentative selections forward.',
    "- Read the repo's own docs + targeted greps before fanning out Explore/Plan agents.",
    '',
    '### Tool-use efficiency',
    '',
    '- `grep -n` to locate, then `Read` with `offset`/`limit`; never read big files whole.',
    '- Never `git stash` to baseline-check; use `git diff --name-only` / `git show HEAD:<path>`.',
    '- Pipe long command output through `grep`; batch related greps into one call.',
    '',
  ];
  return `${body.join('\n')}`;
}

// A reviewer draft is USER-OWNED and deliberately marked DRAFT: an agent with an
// unfilled authoritative source must not look invocable to the router.
export function renderReviewerDraft(target: Target): string {
  return `---
description: "DRAFT — fill in the authoritative source before use. Read-only reviewer for ${target.label} (${target.pathPrefix || 'repo root'})."
name: "${target.name}-reviewer"
tools: Read, Grep, Glob
model: haiku
---

You are the ${target.label} reviewer, a read-only auditor for \`${target.pathPrefix || './'}\`.

<!-- TODO(claude-kit): this is a DRAFT. Fill in the authoritative source below and delete
     the DRAFT marker from the description above. See the full pattern in
     .claude/kit-templates/agents/reviewer.agent.md.template — a gitignored reference that
     \`npx claude-kit update\` restores if it's missing. -->

## Authoritative source

\`<path/to/source-of-truth>\`: <why it is authoritative>.

## What you do

1. Read the change under review (diff, file, or description).
2. Read the relevant sections of the authoritative source directly; never rely on memory.
3. Quote the source verbatim; cite file paths with line numbers.
4. Return one verdict: **OK** | **Conflict** (quote rule + conflicting code) | **Gap** (source silent).

## Constraints

- Read-only: describe fixes precisely; never edit.
- \`grep -n\` to locate, then \`Read\` with \`offset\` + \`limit\`; never read large files whole.
- Aim for ≤ 8 tool calls; if no verdict by then, return open questions and stop.
`;
}

// Default .changeset/config.json when the repo has none.
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
