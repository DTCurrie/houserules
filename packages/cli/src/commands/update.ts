import { resolve } from 'node:path';

import {
  detect,
  trackedLedgerSurfaces,
  trackedScriptFiles,
  trackedTemplateFiles,
  untrackFromIndex,
} from '../detect.js';
import type { Ctx } from '../detect.js';
import { ledgerDirFor } from '../core/ledger-dir.js';
import { resolveModuleOptions } from '../module-options.js';
import {
  assertNoRetiredModules,
  resolveRecordedModuleIds,
} from '../retired-modules.js';
import {
  MODULES,
  KitError,
  buildPlan,
  computeEffects,
  computePrune,
} from '../plan.js';
import { buildRegistry } from '../plugin-resolver.js';
import {
  parseSettingsText,
  removeHooksByScript,
  renderSettings,
} from '../merge-settings.js';
import { apply } from '../apply.js';
import { formatterMangleHint } from '../modules/formatter-mangle.js';
import * as ui from '../ui.js';
import type { Flags } from '../cli-contract.js';
import type { Answers } from '../module-def.js';
import type { PlanResult, PruneResult } from '../plan.js';

/** Committed rendered ledgers, or nothing when the kit must not manage that directory. */
function strayLedgerSurfaces(root: string, ctx: Ctx): string[] {
  const dir = ledgerDirFor(ctx);
  return ctx.git.isRepo && dir ? trackedLedgerSurfaces(root, dir) : [];
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
      `${advisories.length} post-install next step${advisories.length === 1 ? '' : 's'} — see: npx agent-kit update --next-steps`,
    );
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
    `${dests.length} file(s) differ from what the kit last wrote, so they were kept. See what changed: npx agent-kit doctor --json, where every drift entry carries a diff.`,
  );
  const hint = formatterMangleHint(
    root,
    dests,
    'Run `npx agent-kit update --force` to restore them',
  );
  if (hint) ui.message(hint);
}

/**
 * Refreshes kit-owned files to this kit version. Local edits are honored, so a manifest
 * hash mismatch skips the file unless `--force`. Files and hooks the current kit no
 * longer ships are pruned when they are kit-owned and unmodified. Genuinely-new default
 * modules are advertised, never auto-enabled.
 */
export async function update(dir: string, flags: Flags): Promise<number> {
  const root = resolve(dir);
  const ctx = detect(root);
  const registry = buildRegistry(root, ctx.claude.kitConfig, MODULES);
  const manifest = ctx.claude.manifest;
  if (!manifest) {
    console.error(
      'No .claude/kit-manifest.json — this repo has no kit install to update. Run: npx agent-kit init',
    );
    return 1;
  }
  if (ctx.claude.settingsParseError) {
    console.error(
      `.claude/settings.json is not valid JSON (${ctx.claude.settingsParseError}). Fix it by hand first.`,
    );
    return 1;
  }

  ui.intro(
    `agent-kit ${flags.kitVersion} — update (installed: v${manifest.kitVersion})`,
  );

  // Targets come from the user-edited kit.config.json when present: config is
  // the contract. Detection is only the fallback.
  const targets = ctx.claude.kitConfig?.targets?.length
    ? ctx.claude.kitConfig.targets
    : ctx.targets;
  const recordedModuleIds = manifest.modules ?? ['core'];

  let planResult: PlanResult;
  let updateModuleIds: string[];
  try {
    // Both of these are inside the KitError handler, and before any plan exists, so computePrune
    // below can never see a plan that is missing a module's files. Continuing would delete them
    // and look identical to a deliberate removal.
    //
    // Resolution runs first. A pre-split manifest records bare ids that the registry no longer
    // answers to, and buildPlan matches on the registered id, so leaving them bare would drop
    // every plugin module's actions and prune its files. The gate runs on the resolved ids, and
    // an id nothing supplies survives resolution unchanged, so it is still reported.
    updateModuleIds = resolveRecordedModuleIds(recordedModuleIds, registry);
    assertNoRetiredModules(updateModuleIds, registry);
    const moduleOptions = resolveModuleOptions(
      registry,
      updateModuleIds,
      ctx.claude.kitConfig?.moduleOptions,
    );
    const answers: Answers = {
      moduleIds: updateModuleIds,
      targets,
      seedChangesetConfig: false,
      moduleOptions,
    };
    planResult = computeEffects(root, buildPlan(ctx, answers, registry), {
      manifest,
      force: flags.force,
    });
  } catch (e) {
    if (e instanceof KitError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

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

  // init unions new defaults, but update (the path people actually use) did not.
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
    ui.note(lines.join('\n'), 'Prune (retired by this kit version)');
  }
  if (addable.length)
    ui.message(
      `New default module(s) available: ${addable.join(', ')} — enable with: npx agent-kit modules --modules=${addable.join(',')}`,
    );

  // A git-index migration, not a target-file write, so it lives here rather than in
  // apply(). Computed up front so the dry-run preview reflects it and cannot lie.
  const strayTemplates = ctx.git.isRepo ? trackedTemplateFiles(root) : [];

  // Same migration for .claude/scripts/, skipped when the repo opted in to committing them.
  const commitScripts = ctx.claude.kitConfig?.scripts?.commit === true;
  const strayScripts =
    ctx.git.isRepo && !commitScripts ? trackedScriptFiles(root) : [];

  if (flags.dryRun) {
    if (strayTemplates.length)
      ui.message(
        `kit-templates: ${strayTemplates.length} committed reference template(s) would be untracked from git (kept on disk).`,
      );
    if (strayScripts.length)
      ui.message(
        `scripts: ${strayScripts.length} committed hook script(s) would be untracked from git (kept on disk).`,
      );
    const dryLedgers = strayLedgerSurfaces(root, ctx);
    if (dryLedgers.length)
      ui.message(
        `ledgers: ${dryLedgers.length} committed rendered file(s) would be untracked from git (kept on disk).`,
      );
    showNextSteps(planResult.advisories, flags);
    ui.outro('Dry run — nothing written.');
    return 0;
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

  const untracked =
    strayTemplates.length && untrackFromIndex(root, strayTemplates)
      ? strayTemplates.length
      : 0;
  if (untracked)
    ui.message(
      `kit-templates: untracked ${untracked} reference template(s) from git — kept on disk; commit the staged removal to finish.`,
    );

  const untrackedScripts =
    strayScripts.length && untrackFromIndex(root, strayScripts)
      ? strayScripts.length
      : 0;
  if (untrackedScripts)
    ui.message(
      `scripts: untracked ${untrackedScripts} hook script(s) from git — kept on disk; commit the staged removal to finish.`,
    );

  const strayLedgers = strayLedgerSurfaces(root, ctx);
  const untrackedLedgers =
    strayLedgers.length && untrackFromIndex(root, strayLedgers)
      ? strayLedgers.length
      : 0;
  if (untrackedLedgers)
    ui.message(
      `ledgers: untracked ${untrackedLedgers} rendered file(s) from git — kept on disk; commit the staged removal to finish.`,
    );

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
  return 0;
}
