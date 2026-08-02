import { resolve } from 'node:path';

import { detect } from '../detect.js';
import {
  MODULES,
  KitError,
  buildPlan,
  computeEffects,
  computePrune,
} from '../plan.js';
import {
  parseSettingsText,
  removeSettingsFragments,
  renderSettings,
} from '../merge-settings.js';
import { apply } from '../apply.js';
import * as ui from '../ui.js';
import type {
  Answers,
  Ctx,
  Flags,
  KitManifest,
  ModuleDef,
  PlanResult,
} from '../types.js';

// Headless selection, intersected with what is actually available.
export function parseRequested(
  modulesFlag: string | undefined,
  available: ModuleDef[],
): { chosen: string[]; unknown: string[] } {
  const availIds = new Set(available.map((m) => m.id));
  const chosen: string[] = [];
  const unknown: string[] = [];
  for (const raw of (modulesFlag ?? '').split(',')) {
    const id = raw.trim();
    if (!id) continue;
    if (availIds.has(id)) chosen.push(id);
    else unknown.push(id);
  }
  return { chosen: [...new Set(chosen)], unknown };
}

/**
 * `--disable=<ids>`: withdraw modules from an existing install. Files the reduced
 * plan no longer produces are pruned by the same hash-guarded path `update` uses
 * (a file you edited is kept and reported, not deleted), and the disabled modules'
 * settings entries are withdrawn only where no remaining module still needs them.
 */
async function disableModules(
  root: string,
  ctx: Ctx,
  flags: Flags,
  manifest: KitManifest,
  installed: Set<string>,
): Promise<number> {
  const requested = flags.disable
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const known = new Set(MODULES.map((m) => m.id));
  const locked = new Set(MODULES.filter((m) => m.locked).map((m) => m.id));

  const problems = requested.filter((id) => !known.has(id));
  if (problems.length) {
    console.error(`Unknown module(s): ${problems.join(', ')}`);
    return 1;
  }
  const refused = requested.filter((id) => locked.has(id));
  if (refused.length) {
    console.error(
      `Cannot disable ${refused.join(', ')} — the kit does not function without it.`,
    );
    return 1;
  }
  const doomed = requested.filter((id) => installed.has(id));
  if (!doomed.length) {
    ui.outro('None of those modules are installed — nothing to do.');
    return 0;
  }

  const remaining = [...installed].filter((id) => !doomed.includes(id));
  const targets = ctx.claude.kitConfig?.targets?.length
    ? ctx.claude.kitConfig.targets
    : ctx.targets;
  const base = { targets, seedChangesetConfig: false };

  const fragmentsOf = (moduleIds: string[]) =>
    buildPlan(ctx, { ...base, moduleIds })
      .filter((a) => a.kind === 'merge-settings')
      .map((a) => a.fragment);

  let planResult: PlanResult;
  try {
    planResult = computeEffects(
      root,
      buildPlan(ctx, { ...base, moduleIds: remaining }),
      {
        manifest,
      },
    );
  } catch (e) {
    if (e instanceof KitError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

  const prune = computePrune(root, {
    manifest,
    plannedDests: planResult.plannedDests,
    force: flags.force,
  });

  // Fold the withdrawal into the same settings write the remaining modules produce,
  // so settings.json is written once and never loses a user entry in the process.
  const currentSettings = planResult.settingsPlan
    ? parseSettingsText(planResult.settingsPlan.text!)
    : (ctx.claude.settings ?? {});
  const { merged, changes } = removeSettingsFragments(
    currentSettings,
    fragmentsOf(doomed),
    fragmentsOf(remaining),
  );
  if (changes.length) {
    planResult.settingsPlan ??= {
      dest: '.claude/settings.json',
      existedBefore: ctx.claude.settingsExists,
      changes: [],
    };
    planResult.settingsPlan.text = renderSettings(merged);
    planResult.settingsPlan.changes.push(...changes);
  }

  const lines = [
    ...prune.deletes.map(
      (d) => `- ${d.dest}${d.gone ? ' (already gone)' : ''}`,
    ),
    ...prune.kept.map(
      (k) => `! ${k} — locally edited: kept (--force to remove)`,
    ),
    ...changes.map((c) => `± settings.json: ${c.detail}`),
  ];
  ui.note(
    lines.length ? lines.join('\n') : '(nothing to remove)',
    flags.dryRun
      ? `Disable ${doomed.join(', ')} (dry run)`
      : `Disable ${doomed.join(', ')}`,
  );

  if (flags.dryRun) {
    ui.outro('Dry run — nothing written.');
    return 0;
  }
  if (!flags.yes) {
    const go = await ui.confirm(`Disable ${doomed.join(', ')}?`);
    if (!go) {
      ui.outro('Aborted — nothing written.');
      return 1;
    }
  }

  const { written } = apply(
    root,
    { ...planResult, prune },
    {
      kitVersion: flags.kitVersion,
      moduleIds: remaining,
      previousManifest: manifest,
    },
  );
  ui.written(written);
  ui.outro(
    `Disabled ${doomed.join(', ')}. Validate any time with: npx claude-kit doctor`,
  );
  return 0;
}

/**
 * Lists installed against available modules, enables more after init, and withdraws them
 * again with `--disable`. Runs the same detect, plan, preview, apply pipeline as init, so
 * only the delta is written.
 *
 * Disabling is the one destructive path and is deliberately narrow. Kit-owned files the
 * reduced plan no longer produces are pruned, hash-guarded so your edits survive. Only
 * the settings entries the disabled modules contributed, and that no remaining module
 * still contributes, are withdrawn. Shared host files are never deleted, only unwired.
 */
export async function modules(dir: string, flags: Flags): Promise<number> {
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

  if (flags.disable) {
    return disableModules(root, ctx, flags, manifest, installed);
  }

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

  let chosen: string[];
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
  // Config is the contract when the user has edited it. Detection is the fallback.
  const targets = ctx.claude.kitConfig?.targets?.length
    ? ctx.claude.kitConfig.targets
    : ctx.targets;

  const answers: Answers = { moduleIds, targets, seedChangesetConfig: false };
  if (chosen.includes('changesets') && !ctx.changesets.configExists) {
    answers.seedChangesetConfig = flags.yes
      ? true
      : await ui.confirm('No .changeset/config.json — seed a default one?');
  }

  let planResult: PlanResult;
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

  // buildPlan re-plans the whole module set, so its advisories cover modules installed
  // long ago. Only the newly-added ones are news here.
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
