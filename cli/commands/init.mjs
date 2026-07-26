// `claude-kit init` (claude-kit CLI): detect → choose → plan → preview → apply.

import { realpathSync } from 'node:fs';
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

// True when two paths point at the same directory, resolving symlinks (git's
// toplevel is a realpath; resolve() alone is not, so /var vs /private/var on macOS
// would spuriously differ). Falls back to a plain resolve compare if realpath fails.
function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

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
  // Refuse a below-toplevel install: the payload's hooks resolve every path from the
  // git toplevel (repoRoot()), so a .claude/ written in a subdir would never be found
  // — a silently broken install. Compare realpaths (git returns the physical path;
  // /tmp→/private on macOS would otherwise make every install look like a subdir).
  if (ctx.git.top && !samePath(root, ctx.git.top)) {
    throw new KitError(
      `Refusing to install below the git root.\n` +
        `  here:     ${root}\n` +
        `  git root: ${ctx.git.top}\n` +
        `The kit's hooks resolve paths from the git toplevel, so a .claude/ here would never be found.\n` +
        `Install from the toplevel instead:\n  cd ${ctx.git.top} && npx claude-kit init`,
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
    ui.message(
      `This repo already has kit v${installed.kitVersion}. init re-plans with your existing module set as the default; for a plain refresh of kit-owned files use: npx claude-kit update`,
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
    ui.nextSteps(planResult.advisories);
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

  ui.written(written);
  ui.nextSteps(planResult.advisories);
  ui.outro('Installed. Validate any time with: npx claude-kit doctor');
  return 0;
}
