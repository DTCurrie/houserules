// changesets module (claude-kit CLI): changesets is the canonical changelog.
// Deterministic changeset authoring (changeset-write.mjs), a Stop-hook presence
// nudge (changeset-check.mjs), the /changeset skill, and the changeset-writer agent.
//
// HARD RULE: this module never runs a package manager. Repos with pnpm
// `catalogMode: strict` would hard-fail a bare `pnpm add -D`, and installs mean
// network + postinstall scripts + lockfile churn mid-init. Nothing in the payload
// needs @changesets/cli at runtime — changeset files are plain markdown; only
// `changeset version/status` (release time) needs the CLI, so we advise instead.

import { renderChangesetConfig } from '../render.mjs';
import { agent, hookFragment, script, scriptPermission, skill } from './shared.mjs';

export const id = 'changesets';
export const title = 'Changesets integration (canonical changelog)';
export const group = 'recommended';

export function hint(ctx) {
  const cs = ctx.changesets;
  if (cs.configExists) return `.changeset/ found (${cs.pendingCount} pending)`;
  if (ctx.isMonorepo) return 'workspace monorepo — recommended';
  return 'no .changeset/ yet — will seed config';
}

export function defaultEnabled(ctx) {
  return ctx.changesets.configExists || ctx.isMonorepo;
}

function devDepAdvisory(ctx) {
  const cs = ctx.changesets;
  if (cs.invocation === 'devdep') return null;
  if (cs.invocation === 'root-script') {
    return `changesets is invoked via your root "${cs.rootScript}" script — works as-is for versioning/publishing.`;
  }
  const pm = ctx.packageManager?.name ?? 'npm';
  const add = pm === 'pnpm' ? 'pnpm add -D @changesets/cli' : pm === 'yarn' ? 'yarn add -D @changesets/cli' : `${pm} install -D @changesets/cli`;
  const catalogNote = ctx.pnpmCatalogModeStrict
    ? ' NOTE: this repo uses pnpm catalogMode: strict — add a catalog entry for @changesets/cli first, or the add will fail.'
    : '';
  return `For release time (changeset version/publish), add the CLI when convenient: \`${add}\`.${catalogNote} The kit's scripts work without it.`;
}

export function plan(ctx, answers) {
  const actions = [
    script(id, 'changeset-write.mjs', 'non-interactive, workspace-validated changeset author'),
    script(id, 'changeset-check.mjs', 'Stop hook: nudge when package source changed with no changeset'),
    skill(id, 'changeset', 'record a changeset for the packages a change touched'),
    agent(id, 'changeset-writer', 'writes the changeset for a completed change (haiku)'),
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
