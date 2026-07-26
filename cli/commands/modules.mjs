// `claude-kit modules` (claude-kit CLI): list installed vs available modules and
// enable more after init. Add-only — removing/uninstalling a module is a non-goal
// (the kit has no delete/unmerge machinery). `update` stays refresh-only; this is
// the curated "turn a feature on later" surface over the same detect → plan →
// preview → apply pipeline, so only the newly-chosen module's delta is written.

import { resolve } from 'node:path';

import { detect } from '../detect.mjs';
import { MODULES, KitError, buildPlan, computeEffects } from '../plan.mjs';
import { apply } from '../apply.mjs';
import * as ui from '../ui.mjs';

// Headless selection: --modules=<a,b>, intersected with what's actually available.
function parseRequested(modulesFlag, available) {
  const availIds = new Set(available.map((m) => m.id));
  const chosen = [];
  const unknown = [];
  for (const raw of (modulesFlag ?? '').split(',')) {
    const id = raw.trim();
    if (!id) continue;
    if (availIds.has(id)) chosen.push(id);
    else unknown.push(id);
  }
  return { chosen: [...new Set(chosen)], unknown };
}

export async function modules(dir, flags) {
  const root = resolve(dir);
  const ctx = detect(root);
  const manifest = ctx.claude.manifest;
  if (!manifest) {
    console.error(
      'No .claude/kit-manifest.json — nothing installed here yet. Run: npx claude-kit init',
    );
    return 1;
  }
  if (ctx.claude.settingsParseError) {
    console.error(
      `.claude/settings.json is not valid JSON (${ctx.claude.settingsParseError}). Fix it by hand first.`,
    );
    return 1;
  }

  ui.intro(`claude-kit ${flags.kitVersion} — modules`);

  const installed = new Set(manifest.modules ?? ['core']);
  const available = MODULES.filter((m) => !m.locked && !installed.has(m.id));

  const statusTable = MODULES.map((m) => {
    const mark = installed.has(m.id) ? '✓ installed' : '○ available';
    return ui.labelled(
      `${mark}  `,
      `${m.id}${m.locked ? ' (always)' : ''} — ${m.title}`,
    );
  }).join('\n');
  ui.note(statusTable, 'Modules');

  if (!available.length) {
    ui.outro('Every module is already installed — nothing to add.');
    return 0;
  }

  let chosen;
  if (flags.yes) {
    const { chosen: picked, unknown } = parseRequested(
      flags.modules,
      available,
    );
    if (unknown.length)
      console.error(
        `Ignoring unknown or already-installed module(s): ${unknown.join(', ')}`,
      );
    chosen = picked;
    if (!chosen.length) {
      ui.outro(
        'Nothing to add — pass --modules=<id,...> to enable available modules headlessly.',
      );
      return 0;
    }
  } else {
    chosen = await ui.selectNewModules(available, ctx);
    if (!chosen.length) {
      ui.outro('Nothing selected — nothing written.');
      return 0;
    }
  }

  const moduleIds = [...new Set([...installed, ...chosen])];
  // Config is the contract when the user has edited it; detection is the fallback.
  const targets = ctx.claude.kitConfig?.targets?.length
    ? ctx.claude.kitConfig.targets
    : ctx.targets;

  const answers = { moduleIds, targets, seedChangesetConfig: false };
  if (chosen.includes('changesets') && !ctx.changesets.configExists) {
    answers.seedChangesetConfig = flags.yes
      ? true
      : await ui.confirm('No .changeset/config.json — seed a default one?');
  }

  let planResult;
  try {
    planResult = computeEffects(root, buildPlan(ctx, answers), { manifest });
  } catch (e) {
    if (e instanceof KitError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

  const label = `Add ${chosen.join(', ')}`;
  ui.note(
    ui.renderPreview(planResult),
    flags.dryRun ? `${label} (dry run)` : label,
  );

  // buildPlan re-plans the whole module set, so its advisories cover modules the
  // user installed long ago. Only the newly-added ones are news here.
  const advisories = planResult.advisories.filter((a) =>
    chosen.includes(a.module),
  );

  if (flags.dryRun) {
    ui.nextSteps(advisories);
    ui.outro('Dry run — nothing written.');
    return 0;
  }
  if (!flags.yes) {
    const go = await ui.confirm('Add these modules?');
    if (!go) {
      ui.outro('Aborted — nothing written.');
      return 1;
    }
  }

  const { written } = apply(root, planResult, {
    kitVersion: flags.kitVersion,
    moduleIds,
    previousManifest: manifest,
  });
  ui.written(written);
  ui.nextSteps(advisories);
  ui.outro(
    `Added ${chosen.join(', ')}. Validate any time with: npx claude-kit doctor`,
  );
  return 0;
}
