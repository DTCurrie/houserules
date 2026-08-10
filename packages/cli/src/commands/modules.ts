import { resolve } from 'node:path';

import { detect } from '../detect.js';
import {
  parseModuleOptionFlags,
  resolveModuleOptions,
} from '../module-options.js';
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
  removeSettingsFragments,
  renderSettings,
} from '../merge-settings.js';
import { apply } from '../apply.js';
import { settingsParseErrorMessage } from '../core/settings-guard.js';
import * as ui from '../ui.js';
import type { Flags } from '../cli-contract.js';
import type { KitManifest } from '../core/manifest.js';
import type { Ctx } from '../detect.js';
import type { Answers } from '../module-def.js';
import type { PlanResult } from '../plan.js';
import type { Registry, RegisteredModule } from '../plugin-registry.js';

/**
 * Splits a `--modules` list into the ids this run can act on and the ids it cannot.
 *
 * Resolution is against the whole REGISTRY, not against what happens to be installable right
 * now, and that distinction is the point. An id the registry cannot resolve is a user error
 * whatever the install state, while an id that is merely installed already is a no-op. Folding
 * the two together is what let a typo, or a module whose plugin is missing from
 * `kit.config.json`, read back as "you already have that".
 *
 * @param installed Module ids the manifest records, which make a request redundant.
 */
export function parseRequested(
  modulesFlag: string | undefined,
  registry: Registry,
  installed: Set<string>,
): { chosen: string[]; redundant: string[]; unresolvable: string[] } {
  const chosen: string[] = [];
  const redundant: string[] = [];
  const unresolvable: string[] = [];
  for (const raw of (modulesFlag ?? '').split(',')) {
    const id = raw.trim();
    if (!id) continue;
    const found = registry.get(id);
    if (!found) unresolvable.push(id);
    else if (found.def.locked || installed.has(id)) redundant.push(id);
    else chosen.push(id);
  }
  return {
    chosen: [...new Set(chosen)],
    redundant: [...new Set(redundant)],
    unresolvable: [...new Set(unresolvable)],
  };
}

/**
 * The modules this run is ADDING that declare options, and so have a question to ask.
 *
 * Keyed on what was chosen, never on the whole enabled set. A module installed long ago
 * has its options settled in `kit.config.json`, and re-asking on every `modules` run would
 * turn a command about adding things into a settings editor. Changing a settled selection is
 * `--reconfigure`.
 */
export function optionBearingAdditions(
  registry: Registry,
  chosen: string[],
): RegisteredModule[] {
  return registry.modules.filter((m) => chosen.includes(m.id) && m.def.options);
}

/**
 * `--reconfigure=<ids>`: replan an installed module against a NEW option selection.
 *
 * The module set does not change. Only the selections do, so the plan gains the files the new
 * values produce and retires the ones the old values did. Withdrawal runs through the same
 * hash-guarded `computePrune` that `--disable` uses, so a guide you edited is kept and
 * reported rather than deleted.
 *
 * A separate flag rather than an overload of `--module-option`, which already means "configure
 * what I am adding". Making the same flag mean "reconfigure what I have" whenever `--modules`
 * happens to be absent is an implicit mode switch, and the two operations prune differently.
 */
async function reconfigureModules(
  root: string,
  ctx: Ctx,
  flags: Flags,
  manifest: KitManifest,
  installed: Set<string>,
  registry: Registry,
  optionOverrides: Record<string, string[]>,
): Promise<number> {
  const requested = flags.reconfigure
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const unknown = requested.filter((id) => !registry.get(id));
  if (unknown.length) {
    console.error(`Unknown module(s): ${unknown.join(', ')}`);
    return 1;
  }
  const notInstalled = requested.filter((id) => !installed.has(id));
  if (notInstalled.length) {
    console.error(
      `Not installed: ${notInstalled.join(', ')}. Add a module with --modules=<ids> before reconfiguring it.`,
    );
    return 1;
  }
  const optionless = requested.filter((id) => !registry.get(id)?.def.options);
  if (optionless.length) {
    console.error(
      `No options to configure: ${optionless.join(', ')}. Only a module that declares options can be reconfigured.`,
    );
    return 1;
  }
  if (!requested.length) {
    ui.outro('No modules named — nothing to reconfigure.');
    return 0;
  }

  const moduleIds = [...installed];
  const targets = ctx.claude.kitConfig?.targets?.length
    ? ctx.claude.kitConfig.targets
    : ctx.targets;

  let moduleOptions = resolveModuleOptions(
    registry,
    moduleIds,
    ctx.claude.kitConfig?.moduleOptions,
    optionOverrides,
  );
  if (flags.yes) {
    const unanswered = requested.filter((id) => !(id in optionOverrides));
    if (unanswered.length) {
      console.error(
        `--yes cannot prompt. Pass --module-option <id>=<values> for: ${unanswered.join(', ')}`,
      );
      return 1;
    }
  } else {
    const asked = registry.modules.filter((m) => requested.includes(m.id));
    moduleOptions = await ui.selectModuleOptions(asked, moduleOptions);
  }

  let planResult: PlanResult;
  try {
    planResult = computeEffects(
      root,
      buildPlan(
        ctx,
        { moduleIds, targets, seedChangesetConfig: false, moduleOptions },
        registry,
      ),
      { manifest, plugins: registry.plugins },
    );
  } catch (e) {
    if (e instanceof KitError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

  // Reported, not fatal. Reconfiguring changes module OPTIONS and never widens the recorded
  // module set, and `plannedDests` already folds in the broken plugin's dests so its
  // installed files are not pruned as retired.
  for (const problem of planResult.brokenPlugins) ui.message(problem.message);

  const prune = computePrune(root, {
    manifest,
    plannedDests: planResult.plannedDests,
    force: flags.force,
  });

  const label = `Reconfigure ${requested.join(', ')}`;
  const lines = [
    ui.renderPreview(planResult),
    ...prune.deletes.map(
      (d) => `- ${d.dest}${d.gone ? ' (already gone)' : ''}`,
    ),
    ...prune.kept.map(
      (k) => `! ${k} — locally edited: kept (--force to remove)`,
    ),
  ].filter(Boolean);
  ui.note(lines.join('\n'), flags.dryRun ? `${label} (dry run)` : label);

  if (flags.dryRun) {
    ui.outro('Dry run — nothing written.');
    return 0;
  }
  if (!flags.yes) {
    const go = await ui.confirm('Apply this selection?');
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
      moduleIds,
      previousManifest: manifest,
      plugins: registry.plugins,
    },
  );
  ui.written(written);
  ui.outro(
    `Reconfigured ${requested.join(', ')}. Validate any time with: npx agent-kit doctor`,
  );
  return 0;
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
  registry: Registry,
  optionOverrides: Record<string, string[]>,
): Promise<number> {
  const requested = flags.disable
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const known = new Set(registry.modules.map((m) => m.id));
  const locked = new Set(
    registry.modules.filter((m) => m.def.locked).map((m) => m.id),
  );

  const problems = requested.filter((id) => !known.has(id));
  if (problems.length) {
    console.error(`Unknown module(s): ${problems.join(', ')}`);
    return 1;
  }
  const refused = requested.filter((id) => locked.has(id));
  if (refused.length) {
    console.error(
      `Cannot disable ${refused.join(', ')}. The kit does not function without it.`,
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
  const moduleOptions = resolveModuleOptions(
    registry,
    [...installed],
    ctx.claude.kitConfig?.moduleOptions,
    optionOverrides,
  );
  const base = { targets, seedChangesetConfig: false, moduleOptions };

  const fragmentsOf = (moduleIds: string[]) =>
    buildPlan(ctx, { ...base, moduleIds }, registry)
      .filter((a) => a.kind === 'merge-settings')
      .map((a) => a.fragment);

  let planResult: PlanResult;
  try {
    planResult = computeEffects(
      root,
      buildPlan(ctx, { ...base, moduleIds: remaining }, registry),
      {
        manifest,
        plugins: registry.plugins,
      },
    );
  } catch (e) {
    if (e instanceof KitError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

  // Reported, not fatal. Withdrawing a module must not be blocked by an unrelated plugin
  // whose payload is unbuilt, since disabling is one of the ways out of a broken install.
  for (const problem of planResult.brokenPlugins) ui.message(problem.message);

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
      plugins: registry.plugins,
    },
  );
  ui.written(written);
  ui.outro(
    `Disabled ${doomed.join(', ')}. Validate any time with: npx agent-kit doctor`,
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
  const registry = buildRegistry(root, ctx.claude.kitConfig, MODULES);
  const manifest = ctx.claude.manifest;
  if (!manifest) {
    console.error(
      'No .claude/kit-manifest.json — nothing installed here yet. Run: npx agent-kit init',
    );
    return 1;
  }
  const settingsError = settingsParseErrorMessage(ctx);
  if (settingsError) {
    console.error(settingsError);
    return 1;
  }

  ui.intro(`agent-kit ${flags.kitVersion} — modules`);

  const installed = new Set(manifest.modules ?? ['core']);

  let optionOverrides: Record<string, string[]>;
  try {
    optionOverrides = parseModuleOptionFlags(flags.moduleOption ?? []);
  } catch (e) {
    if (e instanceof KitError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

  if (flags.disable) {
    return disableModules(
      root,
      ctx,
      flags,
      manifest,
      installed,
      registry,
      optionOverrides,
    );
  }

  // Before the every-module-installed early return below, since a fully installed repo is
  // exactly where reconfiguring is the only thing left to do.
  if (flags.reconfigure) {
    return reconfigureModules(
      root,
      ctx,
      flags,
      manifest,
      installed,
      registry,
      optionOverrides,
    );
  }

  // Ahead of both the status table and the nothing-to-add early return below. An id the
  // registry cannot resolve is a user error regardless of what is installed, and a repo with
  // every module installed used to return 0 before this was ever checked.
  const requested = parseRequested(flags.modules, registry, installed);
  if (requested.unresolvable.length) {
    console.error(
      `Unknown module(s): ${requested.unresolvable.join(', ')}\n` +
        'If these come from a plugin, check the "plugins" array in .claude/kit.config.json. ' +
        'Diagnose with: npx agent-kit doctor',
    );
    return 1;
  }

  const available = registry.modules.filter(
    (m) => !m.def.locked && !installed.has(m.id),
  );

  const statusTable = registry.modules
    .map((m) => {
      const mark = installed.has(m.id) ? '✓ installed' : '○ available';
      return ui.labelled(
        `${mark}  `,
        `${m.id}${m.def.locked ? ' (always)' : ''} — ${m.def.title}`,
      );
    })
    .join('\n');
  ui.note(statusTable, 'Modules');

  if (!available.length) {
    ui.outro('Every module is already installed — nothing to add.');
    return 0;
  }

  let chosen: string[];
  if (flags.yes) {
    chosen = requested.chosen;
    if (!chosen.length) {
      ui.outro(
        requested.redundant.length
          ? `Already installed: ${requested.redundant.join(', ')} — nothing to add.`
          : 'Nothing to add — pass --modules=<id,...> to enable available modules headlessly.',
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

  let addedOptions = resolveModuleOptions(
    registry,
    moduleIds,
    ctx.claude.kitConfig?.moduleOptions,
    optionOverrides,
  );
  if (!flags.yes) {
    addedOptions = await ui.selectModuleOptions(
      optionBearingAdditions(registry, chosen),
      addedOptions,
    );
  }

  const answers: Answers = {
    moduleIds,
    targets,
    seedChangesetConfig: false,
    moduleOptions: addedOptions,
  };
  if (chosen.includes('changesets') && !ctx.changesets.configExists) {
    answers.seedChangesetConfig = flags.yes
      ? true
      : await ui.confirm('No .changeset/config.json — seed a default one?');
  }

  let planResult: PlanResult;
  try {
    planResult = computeEffects(root, buildPlan(ctx, answers, registry), {
      manifest,
      plugins: registry.plugins,
    });
  } catch (e) {
    if (e instanceof KitError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

  // Same reasoning as init: the manifest records the chosen module ids whether or not their
  // effects ran, so enabling a module from a plugin with no built payload must not write.
  if (planResult.brokenPlugins.length) {
    for (const problem of planResult.brokenPlugins) ui.message(problem.message);
    ui.outro('Nothing written — build the plugin above, then re-run.');
    return 1;
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
    plugins: registry.plugins,
  });
  ui.written(written);
  ui.nextSteps(advisories);
  ui.outro(
    `Added ${chosen.join(', ')}. Validate any time with: npx agent-kit doctor`,
  );
  return 0;
}
