// `claude-kit update` (claude-kit CLI): refresh kit-owned files to this kit
// version, honoring local edits (manifest hash mismatch → skip unless --force).

import { resolve } from 'node:path';

import { detect } from '../detect.mjs';
import { KitError, buildPlan, computeEffects } from '../plan.mjs';
import { apply } from '../apply.mjs';
import * as ui from '../ui.mjs';

export async function update(dir, flags) {
  const root = resolve(dir);
  const ctx = detect(root);
  const manifest = ctx.claude.manifest;
  if (!manifest) {
    console.error('No .claude/kit-manifest.json — this repo has no kit install to update. Run: npx claude-kit init');
    return 1;
  }
  if (ctx.claude.settingsParseError) {
    console.error(`.claude/settings.json is not valid JSON (${ctx.claude.settingsParseError}). Fix it by hand first.`);
    return 1;
  }

  ui.intro(`claude-kit ${flags.kitVersion} — update (installed: v${manifest.kitVersion})`);

  // Targets come from the user-edited kit.config.json when present — config is
  // the contract; detection is only the fallback.
  const targets = ctx.claude.kitConfig?.targets?.length ? ctx.claude.kitConfig.targets : ctx.targets;
  const answers = { moduleIds: manifest.modules ?? ['core'], targets, seedChangesetConfig: false };

  let planResult;
  try {
    planResult = computeEffects(root, buildPlan(ctx, answers), { manifest, force: flags.force });
  } catch (e) {
    if (e instanceof KitError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

  ui.note(ui.renderPreview(planResult), flags.dryRun ? 'Update plan (dry run)' : 'Update plan');
  if (flags.dryRun) {
    ui.outro('Dry run — nothing written.');
    return 0;
  }

  const { written } = apply(root, planResult, {
    kitVersion: flags.kitVersion,
    moduleIds: answers.moduleIds,
    previousManifest: manifest,
  });
  ui.note(ui.renderWritten(written), 'Written');

  const skipped = planResult.effects.filter((e) => e.op === 'skip-modified');
  ui.outro(
    skipped.length
      ? `Done — ${skipped.length} locally-edited file(s) kept as-is (rerun with --force to overwrite).`
      : 'Done.',
  );
  return 0;
}
