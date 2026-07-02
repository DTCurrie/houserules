// Generators for the user-owned files init seeds (claude-kit CLI): kit.config.json,
// CLAUDE.md (when absent), CLAUDE.additions.md (when present), reviewer drafts.
// Seeded files are filled with DETECTED facts — a seeded file must be immediately
// valid, with at most <!-- TODO --> comments, never raw <PLACEHOLDER>s.

const DEFAULT_LINTABLE = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'svelte', 'md', 'json', 'css', 'html'];

function fixDefaultsFor(pm) {
  switch (pm?.name) {
    case 'pnpm':
      return { runner: 'pnpm', filterFlag: '--filter', runScriptPrefix: ['run'], commands: ['lint:fix', 'format:fix'] };
    case 'yarn':
      return { runner: 'yarn', filterFlag: 'workspace', runScriptPrefix: [], commands: ['lint:fix', 'format:fix'] };
    case 'bun':
      return { runner: 'bun', filterFlag: '--filter', runScriptPrefix: ['run'], commands: ['lint:fix', 'format:fix'] };
    default:
      return { runner: 'npm', filterFlag: '', runScriptPrefix: ['run'], commands: ['lint:fix', 'format:fix'] };
  }
}

export function renderKitConfig(ctx, answers) {
  const has = (id) => answers.moduleIds.includes(id);
  const config = {
    version: 2,
    packageManager: ctx.packageManager?.name ?? 'npm',
    fix: fixDefaultsFor(ctx.packageManager),
    lintableExtensions: DEFAULT_LINTABLE,
    generatedFilePattern: '/(?:CHANGELOG|BACKLOG)\\.md$',
    guard: { gitCommit: true, gitPush: true, gitStash: true, prCreate: true, custom: [] },
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
      if (has('ledger')) {
        target.changelogPath = `.claude/changelogs/${t.name}.md`;
        target.logPath = `.claude/changelogs/${t.name}.log`;
      }
      return target;
    }),
  };
  if (has('output-compactor')) {
    config.compactor = { threshold: 10000, headLines: 20, tailLines: 20 };
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

const INTERESTING_SCRIPTS = ['dev', 'build', 'check', 'typecheck', 'lint', 'test', 'verify', 'fix', 'format', 'change'];

function scriptLines(ctx) {
  const scripts = ctx.rootPkg?.scripts ?? {};
  const run = ctx.packageManager?.name === 'npm' ? 'npm run' : (ctx.packageManager?.name ?? 'npm run');
  return INTERESTING_SCRIPTS.filter((s) => scripts[s]).map((s) => `- \`${run} ${s}\``);
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
  const prefixes = answers.targets.map((t) => `\`${t.prefix}\` (${t.pathPrefix || 'repo root'})`).join(', ');
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

export function renderClaudeMd(ctx, answers) {
  const name = ctx.rootPkg?.name ?? 'this repo';
  const lines = [
    `# ${name}`,
    '',
    '<!-- TODO: one-line description of the project. Keep this file lean — it is loaded every turn. -->',
    '',
    '## Layout',
    '',
    ...answers.targets.map((t) => `- \`${t.pathPrefix || './'}\`: ${t.label}${t.packageName && t.packageName !== '.' ? ` (\`${t.packageName}\`)` : ''}`),
    '',
  ];
  const scripts = scriptLines(ctx);
  if (scripts.length) {
    lines.push('## Scripts (run from repo root)', '', ...scripts, '');
  }
  lines.push('## Workflows', '', ...changesetsSection(ctx, answers), ...backlogSection(ctx, answers));
  lines.push(
    '## Conventions',
    '',
    '- **The user always handles `git commit` / `push` / PR-create.** Describe what is ready and stop.',
    '  (Enforced by `.claude/scripts/guard-bash.mjs`.)',
    '- Memory index entries are auto-loaded; the linked files are not. Open a linked memory file only',
    '  when its one-line description is load-bearing for the current task.',
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
    '',
    '---',
    '',
    ...changesetsSection(ctx, answers),
    ...backlogSection(ctx, answers),
    '### Conventions to add',
    '',
    '- **The user always handles `git commit` / `push` / PR-create.** Describe what is ready and stop.',
    '  (Enforced by `.claude/scripts/guard-bash.mjs`.)',
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
     the DRAFT marker from the description above. See
     .claude/kit-templates/agents/reviewer.agent.md.template for the full pattern. -->

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
      baseBranch: ctx.git.branch && ctx.git.branch !== 'HEAD' ? ctx.git.branch : 'main',
      updateInternalDependencies: 'patch',
      ignore: [],
    },
    null,
    2,
  )}\n`;
}
