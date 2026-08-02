import { renderChangesetConfig } from '../render.js';
import type { Action } from '../actions.js';
import type { Ctx } from '../detect.js';
import type { Answers, ModuleGroup } from '../module-def.js';
import { agent, script, skill } from './copy-actions.js';
import { hookFragment, scriptPermission } from './hook-wiring.js';

export const id = 'changesets';
export const title = 'Changesets integration (canonical changelog)';
export const group: ModuleGroup = 'recommended';

export function hint(ctx: Ctx): string {
  const cs = ctx.changesets;
  if (cs.configExists) return `.changeset/ found (${cs.pendingCount} pending)`;
  if (ctx.isMonorepo) return 'workspace monorepo — recommended';
  return 'no .changeset/ yet — will seed config';
}

export function defaultEnabled(ctx: Ctx): boolean {
  return ctx.changesets.configExists || ctx.isMonorepo;
}

function devDepAdvisory(ctx: Ctx): string | null {
  const cs = ctx.changesets;
  if (cs.invocation === 'devdep') return null;
  const pm = ctx.packageManager?.name ?? 'npm';
  const add =
    pm === 'pnpm'
      ? `pnpm add -D ${ctx.isMonorepo ? '-w ' : ''}@changesets/cli`
      : pm === 'yarn'
        ? 'yarn add -D @changesets/cli'
        : `${pm} install -D @changesets/cli`;
  const catalogNote = ctx.pnpmCatalogModeStrict
    ? ' NOTE: this repo uses pnpm catalogMode: strict — add a catalog entry for @changesets/cli first, or the add will fail.'
    : '';
  const via =
    cs.invocation === 'root-script'
      ? `Your root "${cs.rootScript}" script covers versioning/publishing, but changeset `
      : 'Changeset ';
  return `${via}authoring (changeset-write.mjs) needs @changesets/cli installed as a root devDependency: \`${add}\`.${catalogNote}`;
}

/**
 * Wires changesets as the canonical changelog: deterministic authoring, a Stop-hook
 * presence nudge, the skill, and the writer agent.
 *
 * This module never runs a package manager. Repos with pnpm `catalogMode: strict` would
 * hard-fail a bare `pnpm add -D`, and an install means network, postinstall scripts, and
 * lockfile churn mid-init. Since `changeset-write.mjs` authors only through the repo's
 * installed `@changesets/write` and has no fallback, a missing devDependency is advised
 * with the exact install command instead.
 */
export function plan(ctx: Ctx, answers: Answers): Action[] {
  const actions: Action[] = [
    script(
      id,
      'changeset-write.mjs',
      'non-interactive, workspace-validated changeset author',
    ),
    script(
      id,
      'changeset-check.mjs',
      'Stop hook: nudge when package set changed with no changeset',
    ),
    // Installed here rather than written lazily by the hook, so the state directory
    // never surfaces as untracked in the user's `git status`.
    {
      kind: 'write',
      dest: '.claude/state/.gitignore',
      content: [
        '# Per-repo hook state (e.g. the last changeset nudge). Never for commit.',
        '# The directory stays so hooks always have somewhere to persist.',
        '*',
        '!.gitignore',
        '',
      ].join('\n'),
      module: id,
      reason:
        'hook state is throwaway; self-gitignored (repo .gitignore untouched)',
    },
    skill(
      id,
      'changeset',
      'record a changeset for the packages a change touched',
    ),
    agent(
      id,
      'changeset-writer',
      'writes the changeset for a completed change (haiku)',
    ),
    {
      kind: 'merge-settings',
      module: id,
      fragment: {
        permissions: { allow: [scriptPermission('changeset-write.mjs')] },
        ...hookFragment('Stop', null, 'changeset-check.mjs'),
      },
    },
  ];

  if (!ctx.changesets.configExists && answers.seedChangesetConfig !== false) {
    actions.push({
      kind: 'seed',
      dest: '.changeset/config.json',
      content: renderChangesetConfig(ctx),
      module: id,
      reason: 'changesets config (repo had none)',
    });
  }

  const advisory = devDepAdvisory(ctx);
  if (advisory) actions.push({ kind: 'advise', text: advisory, module: id });

  return actions;
}
