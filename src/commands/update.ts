// `claude-kit update` (claude-kit CLI): refresh kit-owned files to this kit
// version, honoring local edits (manifest hash mismatch → skip unless --force),
// PRUNE files/hooks the current kit no longer ships (kit-owned + unmodified only),
// and ADVERTISE genuinely-new default modules (never auto-enable).

import { resolve } from 'node:path';

import { detect, trackedTemplateFiles, untrackFromIndex } from '../detect.js';
import {
  MODULES,
  KitError,
  buildPlan,
  computeEffects,
  computePrune,
} from '../plan.js';
import {
  parseSettingsText,
  removeHooksByScript,
  renderSettings,
} from '../merge-settings.js';
import { apply } from '../apply.js';
import * as ui from '../ui.js';
import type { Answers, Flags, PlanResult, PruneResult } from '../types.js';

// update runs often and its advisories are install-time to-dos the user already saw
// — reprinting the whole list every refresh buries the actual diff. Summarize; the
// full text is one flag away.
function showNextSteps(
  advisories: PlanResult['advisories'],
  flags: Flags,
): void {
  if (!advisories.length) return;
  if (flags.nextSteps) ui.nextSteps(advisories);
  else
    ui.message(
      `${advisories.length} post-install next step${advisories.length === 1 ? '' : 's'} — see: npx claude-kit update --next-steps`,
    );
}

export async function update(dir: string, flags: Flags): Promise<number> {
  const root = resolve(dir);
  const ctx = detect(root);
  const manifest = ctx.claude.manifest;
  if (!manifest) {
    console.error(
      'No .claude/kit-manifest.json — this repo has no kit install to update. Run: npx claude-kit init',
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
    `claude-kit ${flags.kitVersion} — update (installed: v${manifest.kitVersion})`,
  );

  // Targets come from the user-edited kit.config.json when present — config is
  // the contract; detection is only the fallback.
  const targets = ctx.claude.kitConfig?.targets?.length
    ? ctx.claude.kitConfig.targets
    : ctx.targets;
  const answers: Answers = {
    moduleIds: manifest.modules ?? ['core'],
    targets,
    seedChangesetConfig: false,
  };

  let planResult: PlanResult;
  try {
    planResult = computeEffects(root, buildPlan(ctx, answers), {
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

  // Prune: files the current kit no longer produces (kit-owned + hash-unmodified),
  // plus the settings wiring of any retired hook script. Fold the hook removal into
  // the same settings write the additive merge produces, so settings.json is written
  // once — additive entries in, retired kit hooks out — never clobbering user hooks.
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

  // Advertise genuinely-new DEFAULT modules an existing install predates. init unions
  // new defaults; update (the path people use) did not — surface them, never enable.
  const addable = MODULES.filter(
    (m) =>
      !m.locked &&
      m.defaultEnabled(ctx) &&
      !(manifest.modules ?? []).includes(m.id),
  ).map((m) => m.id);

  ui.note(
    ui.renderPreview(planResult),
    flags.dryRun ? 'Update plan (dry run)' : 'Update plan',
  );

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
      `New default module(s) available: ${addable.join(', ')} — enable with: npx claude-kit modules --modules=${addable.join(',')}`,
    );

  // Reference templates are self-gitignored, but an install predating that may
  // have committed them. Reconcile by dropping them from the index (working-tree
  // copies stay). This is a git-index migration, not a target-file write, so it
  // lives here rather than in apply()'s content pipeline — computed up front so
  // the dry-run preview reflects it and can't lie.
  const strayTemplates = ctx.git.isRepo ? trackedTemplateFiles(root) : [];

  if (flags.dryRun) {
    if (strayTemplates.length)
      ui.message(
        `kit-templates: ${strayTemplates.length} committed reference template(s) would be untracked from git (kept on disk).`,
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
      moduleIds: answers.moduleIds,
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

  showNextSteps(planResult.advisories, flags);

  const skipped = planResult.effects.filter((e) => e.op === 'skip-modified');
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
