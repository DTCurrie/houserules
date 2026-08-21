import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  detect,
  trackedLedgerLogs,
  trackedLedgerSurfaces,
  trackedScriptFiles,
  trackedTemplateFiles,
  untrackFromIndex,
} from '../detect.js';
import type { Ctx } from '../detect.js';
import { ledgerDirFor } from '../core/ledger-dir.js';
import { settingsParseErrorMessage } from '../core/settings-guard.js';
import {
  assertOptionsRecorded,
  resolveModuleOptions,
} from '../module-options.js';
import {
  assertNoRetiredModules,
  resolveRecordedModuleIds,
} from '../retired-modules.js';
import { MODULES, buildPlan, computeEffects, computePrune } from '../plan.js';
import { HouseError } from '../house-error.js';
import { buildRegistry } from '../plugin-resolver.js';
import {
  parseSettingsText,
  reconcileSettings,
  removeHooksByScript,
  renderSettings,
} from '@houserules/api/internal';
import { apply } from '../apply.js';
import { formatterMangleHint } from '../modules/formatter-mangle.js';
import * as ui from '../ui.js';
import type { Flags } from '../cli-contract.js';
import type { Answers } from '@houserules/api';
import type { PlanResult, PruneResult } from '../plan.js';

/** Committed rendered ledgers, or nothing when houserules must not manage that directory. */
function strayLedgerSurfaces(root: string, ctx: Ctx): string[] {
  const dir = ledgerDirFor(ctx);
  return ctx.git.isRepo && dir ? trackedLedgerSurfaces(root, dir) : [];
}

/** Committed ledger `.jsonl` logs, or nothing when houserules must not manage that directory. */
function strayLedgerLogs(root: string, ctx: Ctx): string[] {
  const dir = ledgerDirFor(ctx);
  return ctx.git.isRepo && dir ? trackedLedgerLogs(root, dir) : [];
}

/** Ledger scripts with a log still at the pre-split `.claude/` path, not the ledger dir. */
function legacyLedgerScripts(root: string): string[] {
  const scripts: string[] = [];
  if (
    existsSync(join(root, '.claude/backlog.log')) ||
    existsSync(join(root, '.claude/backlog.jsonl'))
  ) {
    scripts.push('backlog-log.mjs');
  }
  if (
    existsSync(join(root, '.claude/decisions.log')) ||
    existsSync(join(root, '.claude/decisions.jsonl'))
  ) {
    scripts.push('decision-log.mjs');
  }
  return scripts;
}

// The rename happens on the first ledger command, not during update, and the markdown only
// once render runs. Without this message a migrating repo updates and finds .claude/ledgers/
// empty with nothing telling them what to run.
function showLegacyLedgerHint(root: string): void {
  for (const script of legacyLedgerScripts(root)) {
    ui.message(
      `ledgers: .claude/scripts/${script} still has a log at the old .claude/ path. Run \`node .claude/scripts/${script} list\` to move it into .claude/ledgers/, then \`node .claude/scripts/${script} render\` to write the markdown.`,
    );
  }
}

// update runs often and its advisories are install-time to-dos the user already saw.
// Reprinting the whole list every refresh buries the actual diff. The full text is one
// flag away.
function showNextSteps(
  advisories: PlanResult['advisories'],
  flags: Flags,
): void {
  if (!advisories.length) return;
  if (flags.nextSteps) ui.nextSteps(advisories);
  else
    ui.message(
      `${advisories.length} post-install next step${advisories.length === 1 ? '' : 's'} — see: npx houserules update --next-steps`,
    );
}

/** Reports, without touching git, how many of `paths` a real run would untrack. */
function reportWouldUntrack(
  paths: string[],
  category: string,
  noun: string,
  tail = '',
): void {
  if (paths.length)
    ui.message(
      `${category}: ${paths.length} committed ${noun} would be untracked from git (kept on disk).${tail}`,
    );
}

/** Untracks `paths` from the git index, keeping the bytes on disk, and reports the count. */
function untrackAndReport(
  root: string,
  paths: string[],
  category: string,
  noun: string,
  tail = '',
): number {
  const count =
    paths.length && untrackFromIndex(root, paths) ? paths.length : 0;
  if (count)
    ui.message(
      `${category}: untracked ${count} ${noun} from git — kept on disk. Commit the staged removal to finish.${tail}`,
    );
  return count;
}

/**
 * Why the kept files differ, and how to see it for yourself.
 *
 * A hash mismatch is the only evidence `update` has, and on its own it reads as an
 * accusation. Without the diff the user cannot tell a formatter rewrite from a real edit,
 * which leaves `--force` as the only lever and no reason to trust it.
 */
function showLocalEdits(root: string, dests: string[]): void {
  if (!dests.length) return;
  ui.message(
    `${dests.length} file(s) differ from what houserules last wrote, so they were kept. See what changed: npx houserules doctor --json, where every drift entry carries a diff.`,
  );
  const hint = formatterMangleHint(
    root,
    dests,
    'Run `npx houserules update --force` to restore them',
  );
  if (hint) ui.message(hint);
}

/**
 * Resolves the recorded module ids against the registry, gates on a retired module or an
 * unrecorded option, and computes the plan. Both gates run before any plan exists, so
 * `computePrune` can never see a plan that is missing a module's files: continuing past
 * either would delete them and look identical to a deliberate removal.
 *
 * @throws HouseError from any of the gates or from `computeEffects` itself, for the caller
 *   to report and exit 1 on.
 */
function resolveUpdatePlan(
  root: string,
  ctx: Ctx,
  registry: ReturnType<typeof buildRegistry>,
  manifest: NonNullable<Ctx['claude']['manifest']>,
  targets: Ctx['targets'],
  flags: Flags,
): { planResult: PlanResult; updateModuleIds: string[] } {
  const recordedModuleIds = manifest.modules ?? ['core'];
  // Resolution runs first. A pre-split manifest records bare ids that the registry no longer
  // answers to, and buildPlan matches on the registered id, so leaving them bare would drop
  // every plugin module's actions and prune its files. The gate runs on the resolved ids, and
  // an id nothing supplies survives resolution unchanged, so it is still reported.
  const updateModuleIds = resolveRecordedModuleIds(recordedModuleIds, registry);
  assertNoRetiredModules(updateModuleIds, registry);
  // Same placement rule as the retired-module gate above: before any plan exists, so the
  // prune below can never be computed from a fallback selection the user never chose.
  if (!flags.force) {
    assertOptionsRecorded(
      registry,
      updateModuleIds,
      ctx.claude.houseConfig?.moduleOptions,
    );
  }
  const moduleOptions = resolveModuleOptions(
    registry,
    updateModuleIds,
    ctx.claude.houseConfig?.moduleOptions,
  );
  const answers: Answers = {
    moduleIds: updateModuleIds,
    targets,
    seedChangesetConfig: false,
    moduleOptions,
  };
  const planResult = computeEffects(root, buildPlan(ctx, answers, registry), {
    manifest,
    force: flags.force,
    plugins: registry.plugins,
  });
  return { planResult, updateModuleIds };
}

/**
 * Refreshes kit-owned files to houserules version. Local edits are honored, so a manifest
 * hash mismatch skips the file unless `--force`. Files and hooks the current houserules no
 * longer ships are pruned when they are kit-owned and unmodified. Genuinely-new default
 * modules are advertised, never auto-enabled.
 */
export async function update(dir: string, flags: Flags): Promise<number> {
  const root = resolve(dir);
  const ctx = detect(root);
  const registry = buildRegistry(root, ctx.claude.houseConfig, MODULES);
  const manifest = ctx.claude.manifest;
  if (!manifest) {
    console.error(
      'No .claude/houserules.manifest.json — this repo has no houserules install to update. Run: npx houserules init',
    );
    return 1;
  }
  const settingsError = settingsParseErrorMessage(ctx);
  if (settingsError) {
    console.error(settingsError);
    return 1;
  }

  ui.intro(
    `houserules ${flags.kitVersion} — update (installed: v${manifest.kitVersion})`,
  );

  // Targets come from the user-edited houserules.config.json when present: config is
  // the contract. Detection is only the fallback.
  const targets = ctx.claude.houseConfig?.targets?.length
    ? ctx.claude.houseConfig.targets
    : ctx.targets;

  let planResult: PlanResult;
  let updateModuleIds: string[];
  try {
    ({ planResult, updateModuleIds } = resolveUpdatePlan(
      root,
      ctx,
      registry,
      manifest,
      targets,
      flags,
    ));
  } catch (e) {
    if (e instanceof HouseError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

  // A broken plugin's missing payload is reported against that plugin, but every other
  // module's plan still renders and applies below. The command still fails, since the
  // broken plugin's files were not refreshed.
  for (const problem of planResult.brokenPlugins) ui.message(problem.message);
  const hasBrokenPlugins = planResult.brokenPlugins.length > 0;

  // The hook removal folds into the same settings write the additive merge produces, so
  // settings.json is written once and never clobbers a user hook.
  const prune: PruneResult = computePrune(root, {
    manifest,
    plannedDests: planResult.plannedDests,
    force: flags.force,
  });
  if (prune.removedScripts.length) {
    const base = planResult.settingsPlan
      ? parseSettingsText(planResult.settingsPlan.text!)
      : (ctx.claude.settings ?? {});
    const { merged, changes } = removeHooksByScript(base, prune.removedScripts);
    if (changes.length) {
      planResult.settingsPlan ??= {
        dest: '.claude/settings.json',
        existedBefore: ctx.claude.settingsExists,
        changes: [],
      };
      planResult.settingsPlan.text = renderSettings(merged);
      planResult.settingsPlan.changes.push(...changes);
    }
  }

  // Reconciles the recorded settings signature against what the CURRENT modules declare,
  // dropping a still-recognizable houserules hook entry that nothing declares anymore even
  // when its script survives on disk (a module rewiring its hook, not retiring the file
  // `removeHooksByScript` above already handled). Folds into the same single write.
  {
    const base = planResult.settingsPlan
      ? parseSettingsText(planResult.settingsPlan.text!)
      : (ctx.claude.settings ?? {});
    const { merged, dropped } = reconcileSettings(
      base,
      planResult.fragments,
      manifest.settings,
    );
    if (dropped.length) {
      planResult.settingsPlan ??= {
        dest: '.claude/settings.json',
        existedBefore: ctx.claude.settingsExists,
        changes: [],
      };
      planResult.settingsPlan.text = renderSettings(merged);
      planResult.settingsPlan.changes.push(
        ...dropped.map(({ event, matcher, script }) => ({
          kind: 'remove-hook' as const,
          detail: `${event}${matcher ? `(${matcher})` : ''}: ${script}`,
        })),
      );
    }
  }

  // init unions new defaults, but update (the path people use) did not.
  // Surface them, never enable them.
  // Against the resolved ids, not the recorded ones. A plugin module the repo already has is
  // recorded bare, so comparing against the manifest would advertise it as newly available.
  const addable = registry.modules
    .filter(
      (m) =>
        !m.def.locked &&
        m.def.defaultEnabled(ctx) &&
        !updateModuleIds.includes(m.id),
    )
    .map((m) => m.id);

  ui.note(
    ui.renderPreview(planResult),
    flags.dryRun ? 'Update plan (dry run)' : 'Update plan',
  );

  const skipped = planResult.effects
    .filter((e) => e.op === 'skip-modified')
    .map((e) => e.action.dest);
  showLocalEdits(root, skipped);

  if (prune.deletes.length || prune.kept.length) {
    const lines: string[] = [];
    for (const d of prune.deletes)
      lines.push(
        `- ${d.dest}${d.gone ? ' (already gone — dropped from manifest)' : d.modified ? ' (was locally edited; --force removed it)' : ''}`,
      );
    for (const k of prune.kept)
      lines.push(
        `! ${k} — retired, but locally edited: kept (--force to remove)`,
      );
    ui.note(lines.join('\n'), 'Prune (retired by houserules version)');
  }
  if (addable.length)
    ui.message(
      `New default module(s) available: ${addable.join(', ')} — enable with: npx houserules modules --modules=${addable.join(',')}`,
    );

  // A git-index migration, not a target-file write, so it lives here rather than in
  // apply(). Computed up front so the dry-run preview reflects it and cannot lie.
  const strayTemplates = ctx.git.isRepo ? trackedTemplateFiles(root) : [];

  // Same migration for .claude/scripts/, skipped when the repo opted in to committing them.
  const commitScripts = ctx.claude.houseConfig?.scripts?.commit === true;
  const strayScripts =
    ctx.git.isRepo && !commitScripts ? trackedScriptFiles(root) : [];

  if (flags.dryRun) {
    reportWouldUntrack(strayTemplates, 'templates', 'reference template(s)');
    reportWouldUntrack(strayScripts, 'scripts', 'hook script(s)');
    reportWouldUntrack(
      strayLedgerSurfaces(root, ctx),
      'ledgers',
      'rendered file(s)',
    );
    reportWouldUntrack(
      strayLedgerLogs(root, ctx),
      'ledgers',
      'ledger log(s)',
      ' The GitHub Project is now the durable record, once `projects-sync.mjs push` has run.',
    );
    showLegacyLedgerHint(root);
    showNextSteps(planResult.advisories, flags);
    ui.outro('Dry run — nothing written.');
    return hasBrokenPlugins ? 1 : 0;
  }

  const { written } = apply(
    root,
    { ...planResult, prune },
    {
      kitVersion: flags.kitVersion,
      // The resolved ids, never the recorded ones. Writing the bare ids back would re-run the
      // migration on every update and leave the manifest disagreeing with the registry forever.
      moduleIds: updateModuleIds,
      previousManifest: manifest,
    },
  );
  ui.written(written);

  untrackAndReport(root, strayTemplates, 'templates', 'reference template(s)');
  untrackAndReport(root, strayScripts, 'scripts', 'hook script(s)');
  untrackAndReport(
    root,
    strayLedgerSurfaces(root, ctx),
    'ledgers',
    'rendered file(s)',
  );
  untrackAndReport(
    root,
    strayLedgerLogs(root, ctx),
    'ledgers',
    'ledger log(s)',
    ' The record now lives in the GitHub Project once `projects-sync.mjs push` has run.',
  );

  showLegacyLedgerHint(root);
  showNextSteps(planResult.advisories, flags);

  const pruned = prune.deletes.filter((d) => !d.gone).length;
  ui.outro(
    [
      pruned ? `pruned ${pruned} retired file(s)` : '',
      skipped.length
        ? `${skipped.length} locally-edited file(s) kept as-is (--force to overwrite)`
        : '',
    ]
      .filter(Boolean)
      .join('; ') || 'Done.',
  );
  return hasBrokenPlugins ? 1 : 0;
}
