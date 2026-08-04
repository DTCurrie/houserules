import {
  definePlugin,
  hookFragment,
  scriptPermission,
} from '@agent-kit/cli/plugin';
import type {
  Action,
  Answers,
  CheckResult,
  Ctx,
  ModuleDef,
  PluginApi,
} from '@agent-kit/cli/plugin';

function renderChangesetConfig(ctx: Ctx): string {
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
function changesetsModule(api: PluginApi): ModuleDef {
  const id = 'changesets';
  return {
    id,
    title: 'Changesets integration (canonical changelog)',
    group: 'recommended',
    hint(ctx: Ctx): string {
      const cs = ctx.changesets;
      if (cs.configExists)
        return `.changeset/ found (${cs.pendingCount} pending)`;
      if (ctx.isMonorepo) return 'workspace monorepo — recommended';
      return 'no .changeset/ yet — will seed config';
    },
    defaultEnabled(ctx: Ctx): boolean {
      return ctx.changesets.configExists || ctx.isMonorepo;
    },
    plan(ctx: Ctx, answers: Answers): Action[] {
      const actions: Action[] = [
        api.payload.script(
          id,
          'changeset-write.mjs',
          'non-interactive, workspace-validated changeset author',
        ),
        api.payload.script(
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
        api.payload.skill(
          id,
          'changeset',
          'record a changeset for the packages a change touched',
        ),
        api.payload.agent(
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

      if (
        !ctx.changesets.configExists &&
        answers.seedChangesetConfig !== false
      ) {
        actions.push({
          kind: 'seed',
          dest: '.changeset/config.json',
          content: renderChangesetConfig(ctx),
          module: id,
          reason: 'changesets config (repo had none)',
        });
      }

      const advisory = devDepAdvisory(ctx);
      if (advisory)
        actions.push({ kind: 'advise', text: advisory, module: id });

      return actions;
    },
    check(ctx: Ctx): CheckResult {
      if (!ctx.changesets.configExists)
        return {
          findings: [
            {
              level: 'ERROR',
              msg: 'changesets module installed but .changeset/config.json is missing',
            },
          ],
          readouts: [],
        };

      if (ctx.changesets.invocation === 'external-cli')
        return {
          findings: [
            {
              level: 'WARN',
              msg: 'changesets CLI not installed (pnpx/npx works; add @changesets/cli as a devDependency for release flows)',
            },
          ],
          readouts: [],
        };

      return { findings: [], readouts: [] };
    },
  };
}

/**
 * A per-commit JSONL changelog, for repos that want commit-granular history alongside
 * changesets. Its files live under `.claude/changelogs/` so they can never collide with
 * the CHANGELOG.md that `changeset version` owns.
 */
function ledgerModule(api: PluginApi): ModuleDef {
  const id = 'ledger';
  return {
    id,
    title: 'Per-commit changelog ledger (in addition to changesets)',
    group: 'optional',
    hint(): string {
      return 'commit-granular history in .claude/changelogs/ — most repos should rely on changesets alone';
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(): Action[] {
      return [
        api.payload.script(
          id,
          'package-changelog.mjs',
          'per-commit ledger (writes .claude/changelogs/)',
        ),
        api.payload.template(
          id,
          'agents/archivist.agent.md.template',
          'ledger archivist pattern',
        ),
        {
          kind: 'merge-settings',
          module: id,
          fragment: {
            permissions: {
              allow: [scriptPermission('package-changelog.mjs')],
            },
          },
        },
        {
          kind: 'advise',
          text: 'Ledger: instantiate an archivist per target from .claude/kit-templates/agents/archivist.agent.md.template (records commits into .claude/changelogs/).',
          module: id,
        },
      ];
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  changesetsModule(api),
  ledgerModule(api),
]);
