// `claude-kit init` (claude-kit CLI): detect → choose → plan → preview → apply.

import { resolve } from 'node:path';

import { detect } from '../detect.mjs';
import { KIT_ROOT } from '../paths.mjs';
import {
  MODULES,
  KitError,
  buildPlan,
  computeEffects,
  resolveModuleIds,
} from '../plan.mjs';
import { apply } from '../apply.mjs';
import * as ui from '../ui.mjs';

function preflight(root, ctx) {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20)
    throw new KitError(
      `Node ${process.versions.node} is too old — the kit needs >= 20.`,
    );
  if (!ctx.git.isRepo) {
    throw new KitError(
      `${root} is not a git work tree. Kit scripts resolve paths from the git root — run git init first.`,
    );
  }
  if (resolve(root) === KIT_ROOT)
    throw new KitError('Refusing to install the kit into itself.');
  if (ctx.claude.settingsParseError) {
    throw new KitError(
      `.claude/settings.json is not valid JSON (${ctx.claude.settingsParseError}). Fix it by hand first.`,
    );
  }
}

export async function init(dir, flags) {
  const root = resolve(dir);
  let ctx;
  try {
    ctx = detect(root);
    preflight(root, ctx);
  } catch (e) {
    if (e instanceof KitError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

  ui.intro(`claude-kit ${flags.kitVersion} — init`);
  ui.note(ui.profileCard(ctx), 'Detected');

  // Already installed? Default to the previously chosen modules.
  const installed = ctx.claude.manifest;
  let moduleIds;
  try {
    moduleIds = installed?.modules?.length
      ? resolveModuleIds(
          ctx,
          flags.modules ? flags.modules : installed.modules.join(','),
        )
      : resolveModuleIds(ctx, flags.modules);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  if (installed) {
    ui.note(
      `This repo already has kit v${installed.kitVersion}. init re-plans with your existing module set as the default;\nfor a plain refresh of kit-owned files use: npx claude-kit update`,
      'Already installed',
    );
  }

  let targets = ctx.targets;
  if (!flags.yes) {
    moduleIds = await ui.selectModules(MODULES, ctx, moduleIds);
    targets = await ui.confirmTargets(targets);
  }

  const answers = { moduleIds, targets, seedChangesetConfig: true };
  if (
    !flags.yes &&
    moduleIds.includes('changesets') &&
    !ctx.changesets.configExists
  ) {
    answers.seedChangesetConfig = await ui.confirm(
      'No .changeset/config.json — seed a default one?',
    );
  }

  let planResult;
  try {
    planResult = computeEffects(root, buildPlan(ctx, answers), {
      manifest: installed,
    });
  } catch (e) {
    if (e instanceof KitError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

  ui.note(
    ui.renderPreview(planResult),
    flags.dryRun ? 'Plan (dry run)' : 'Plan',
  );

  if (flags.dryRun) {
    ui.outro('Dry run — nothing written.');
    return 0;
  }
  if (!flags.yes) {
    const go = await ui.confirm('Apply this plan?');
    if (!go) {
      ui.outro('Aborted — nothing written.');
      return 1;
    }
  }

  const { written } = apply(root, planResult, {
    kitVersion: flags.kitVersion,
    moduleIds,
    previousManifest: installed,
  });

  ui.note(ui.renderWritten(written), 'Written');
  ui.outro('Installed. Validate any time with: npx claude-kit doctor');
  return 0;
}
