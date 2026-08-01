// changesets module (claude-kit CLI): changesets is the canonical changelog.
// Deterministic changeset authoring (changeset-write.mjs), a Stop-hook presence
// nudge (changeset-check.mjs), the /changeset skill, and the changeset-writer agent.
//
// HARD RULE: this module never runs a package manager. Repos with pnpm
// `catalogMode: strict` would hard-fail a bare `pnpm add -D`, and installs mean
// network + postinstall scripts + lockfile churn mid-init. But changeset-write.mjs
// authors ONLY via the repo's installed @changesets/write (no fallback), so when
// the devDependency is missing we advise the exact install command instead.

import { renderChangesetConfig } from '../render.js';
import type { Action, Answers, Ctx, ModuleGroup } from '../types.js';
import {
  agent,
  hookFragment,
  script,
  scriptPermission,
  skill,
} from './shared.js';

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
      'Stop hook: nudge when package source changed with no changeset',
    ),
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
