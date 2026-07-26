// Generators for the user-owned files init seeds (claude-kit CLI): kit.config.json,
// CLAUDE.md (when absent), CLAUDE.additions.md (when present), reviewer drafts.
// Seeded files are filled with DETECTED facts — a seeded file must be immediately
// valid, with at most <!-- TODO --> comments, never raw <PLACEHOLDER>s.

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

function fixDefaultsFor(pm, isMonorepo = true) {
  let defaults;
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
export function verifyDefaultsFor(pm, isMonorepo = true) {
  return { ...fixDefaultsFor(pm, isMonorepo), commands: ['verify'] };
}

export function renderKitConfig(ctx, answers) {
  const has = (id) => answers.moduleIds.includes(id);
  const config = {
    version: 2,
    packageManager: ctx.packageManager?.name ?? 'npm',
    fix: fixDefaultsFor(ctx.packageManager, ctx.isMonorepo),
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
      const target = {
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

function scriptLines(ctx) {
  const scripts = ctx.rootPkg?.scripts ?? {};
  const run =
    ctx.packageManager?.name === 'npm'
      ? 'npm run'
      : (ctx.packageManager?.name ?? 'npm run');
  return INTERESTING_SCRIPTS.filter((s) => scripts[s]).map(
    (s) => `- \`${run} ${s}\``,
  );
}

function changesetsSection(ctx, answers) {
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

function backlogSection(ctx, answers) {
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

function plansSection(ctx, answers) {
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

export function renderClaudeMd(ctx, answers) {
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
  lines.push(
    '## Workflows',
    '',
    ...changesetsSection(ctx, answers),
    ...backlogSection(ctx, answers),
    ...plansSection(ctx, answers),
  );
  lines.push(
    '## Conventions',
    '',
    '- **The user always handles `git commit` / `push` / PR-create.** Describe what is ready and stop.',
    '  (Enforced by `.claude/scripts/guard-bash.mjs`.)',
    '- Memory index entries are auto-loaded; the linked files are not. Open a linked memory file only',
    '  when its one-line description is load-bearing for the current task.',
    '',
    '## Cost & verification discipline',
    '',
    '- **Stage-sized work (≤ a handful of files): implement directly in-context** — no implementation',
    '  subagents; briefs + re-reading + reports cost more than the work. Reserve subagents for genuinely',
    '  parallel or unbounded work (wide sweeps, per-file migrations, broad searches).',
    '- **Verify with static gates** (tests, typecheck, lint), then give the user a short falsifiable',
    '  acceptance checklist to confirm in the running app. Never drive browsers/screenshots for',
    '  verification unless explicitly asked.',
    '- **Derive empirical constants analytically** (parse the artifact — headers, geometry, metadata)',
    '  instead of screenshot-and-iterate loops.',
    '- **An unanswered question is not an answer**: on AskUserQuestion timeout, stop the dependent work',
    '  and re-ask when the user returns — never carry tentative selections forward.',
    "- **Before fanning out Explore/Plan agents, read the repo's own docs + targeted greps**; fan out",
    "  only for what they don't answer.",
    '',
    '## Tool-use efficiency',
    '',
    '- **Read narrow ranges, not whole files.** `grep -n` to locate, then `Read` with `offset` + `limit`.',
    '- **Never `git stash` to baseline-check** — it dumps the untracked-file list into context. Use',
    '  `git diff --name-only` or `git show HEAD:<path>`.',
    '- **Pipe long output through `grep` at the source** instead of reading it whole; batch related',
    '  greps into one call (`grep -nE "a|b|c"`).',
    '- **Run targeted tests by name before a full-suite sweep.**',
    "- **Don't chase generated-file churn** (build artifacts, `CHANGELOG.md`/`BACKLOG.md`); only react",
    '  to source you actually edited.',
    '',
  );
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}`;
}

export function renderClaudeAdditions(ctx, answers) {
  const body = [
    '# CLAUDE.md additions from claude-kit',
    '',
    'Your repo already has a CLAUDE.md, so the kit did not touch it. Merge the sections below',
    'by hand where they fit (keep CLAUDE.md lean — cut anything not true on every turn).',
    'For a fuller from-scratch skeleton to compare structure against, see',
    '`.claude/kit-templates/CLAUDE.md.template` (a gitignored reference; `npx claude-kit update`',
    'restores it if absent).',
    '',
    '---',
    '',
    ...changesetsSection(ctx, answers),
    ...backlogSection(ctx, answers),
    ...plansSection(ctx, answers),
    '### Conventions to add',
    '',
    '- **The user always handles `git commit` / `push` / PR-create.** Describe what is ready and stop.',
    '  (Enforced by `.claude/scripts/guard-bash.mjs`.)',
    '',
    '### Cost & verification discipline (add if you have no equivalent section)',
    '',
    '- Stage-sized work (≤ a handful of files): implement directly in-context; no implementation',
    '  subagents. Reserve subagents for genuinely parallel or unbounded work (wide sweeps, migrations).',
    '- Verify with static gates (tests, typecheck, lint) + a short falsifiable acceptance checklist for',
    '  the user; no browser/screenshot verification unless explicitly asked.',
    '- Derive empirical constants by parsing the artifact itself, not screenshot-and-iterate loops.',
    '- On AskUserQuestion timeout, stop and re-ask later — never carry tentative selections forward.',
    "- Read the repo's own docs + targeted greps before fanning out Explore/Plan agents.",
    '',
    '### Tool-use efficiency (add if you have no equivalent section)',
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
export function renderReviewerDraft(target) {
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
export function renderChangesetConfig(ctx) {
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
