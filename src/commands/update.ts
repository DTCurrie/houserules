import { resolve } from 'node:path';

import {
  detect,
  trackedScriptFiles,
  trackedTemplateFiles,
  untrackFromIndex,
} from '../detect.js';
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
import type { Flags } from '../cli-contract.js';
import type { Answers } from '../module-def.js';
import type { PlanResult, PruneResult } from '../plan.js';

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
      `${advisories.length} post-install next step${advisories.length === 1 ? '' : 's'} — see: npx claude-kit update --next-steps`,
    );
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

  // Targets come from the user-edited kit.config.json when present: config is
  // the contract. Detection is only the fallback.
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

  const untrackedScripts =
    strayScripts.length && untrackFromIndex(root, strayScripts)
      ? strayScripts.length
      : 0;
  if (untrackedScripts)
    ui.message(
      `scripts: untracked ${untrackedScripts} hook script(s) from git — kept on disk; commit the staged removal to finish.`,
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
