import { renderPrepareScriptPlan } from '../render.js';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { detect } from '../detect.js';
import { installedModuleIds } from '../installed-modules.js';
import { KIT_ROOT } from '../paths.js';
import {
  parseModuleOptionFlags,
  resolveModuleOptions,
} from '../module-options.js';
import {
  assertNotWithdrawn,
  closeSelection,
  requiredByNote,
  withdrawnModuleIds,
} from '../module-requires.js';
import type { RequirementClosure } from '../module-requires.js';
import { hasModule } from '@houserules/api';
import {
  MODULES,
  buildPlan,
  computeEffects,
  configOwnership,
  resolveModuleIds,
} from '../plan.js';
import { HouseError } from '../house-error.js';
import { buildRegistry } from '../plugin-resolver.js';
import { validateHouseConfig } from '@houserules/api/internal';
import { apply } from '../apply.js';
import {
  onlyMissingTopLevelKeys,
  planConfigFill,
} from '../core/config-fill.js';
import { settingsParseErrorMessage } from '../core/settings-guard.js';
import * as ui from '../ui.js';
import { EXIT } from '../cli-contract.js';
import { MIN_NODE_MAJOR } from './doctor/environment.js';
import type { Flags } from '../cli-contract.js';
import type { Ctx } from '../detect.js';
import type { Action, Answers, SeedAction } from '@houserules/api';
import type { PlanResult } from '../plan.js';
import type { Registry } from '../plugin-registry.js';

// Symlinks are resolved because git's toplevel is a realpath and resolve() alone is not,
// so /var vs /private/var on macOS would spuriously differ.
function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

function preflight(root: string, ctx: Ctx): void {
  const major = process.versions.node.split('.').map(Number)[0];
  if (major === undefined || major < MIN_NODE_MAJOR)
    throw new HouseError(
      `Node ${process.versions.node} is too old — houserules needs >= ${MIN_NODE_MAJOR}.`,
    );
  if (!ctx.git.isRepo) {
    throw new HouseError(
      `${root} is not a git work tree. Kit scripts resolve paths from the git root. Run git init first.`,
    );
  }
  // The payload's hooks resolve every path from the git toplevel, so a .claude/ written
  // in a subdir would never be found. That is a silently broken install.
  if (ctx.git.top && !samePath(root, ctx.git.top)) {
    throw new HouseError(
      `Refusing to install below the git root.\n` +
        `  here:     ${root}\n` +
        `  git root: ${ctx.git.top}\n` +
        `houserules' hooks resolve paths from the git toplevel, so a .claude/ here would never be found.\n` +
        `Install from the toplevel instead:\n  cd ${ctx.git.top} && npx houserules init`,
    );
  }
  if (resolve(root) === KIT_ROOT)
    throw new HouseError('Refusing to install houserules into itself.');
  const settingsError = settingsParseErrorMessage(ctx);
  if (settingsError) throw new HouseError(settingsError);
}

const CONFIG_DEST = '.claude/houserules.config.json';

/** Prints schema problems of an existing config, with a recovery hint, and returns their count. */
function printConfigProblems(problems: string[]): number {
  for (const problem of problems)
    console.error(`houserules.config.json: ${problem}`);
  if (problems.length)
    console.error(
      'Fix the fields named above, or delete the file and re-run init to seed a fresh one.',
    );
  return problems.length;
}

/**
 * Reads the schema problems of an existing config. Returns the file text and its problems, or
 * null when there is no file.
 */
function readConfigProblems(
  root: string,
): { text: string; problems: string[] } | null {
  const configPath = join(root, ...CONFIG_DEST.split('/'));
  if (!existsSync(configPath)) return null;
  const text = readFileSync(configPath, 'utf8');
  return { text, problems: validateHouseConfig(text) };
}

/** The existing config when the schema rejects it, or null when it is absent, valid, or unreadable. */
function readRejectedConfig(
  root: string,
): { text: string; problems: string[] } | null {
  try {
    const existing = readConfigProblems(root);
    return existing && existing.problems.length > 0 ? existing : null;
  } catch {
    return null;
  }
}

/**
 * Whether the seed can repair a rejected config: it must be a JSON object, and every problem
 * must be a top-level key it leaves unset.
 */
function isFillable(
  rejected: { text: string; problems: string[] },
  ctx: Ctx,
): boolean {
  return (
    ctx.claude.houseConfig != null &&
    onlyMissingTopLevelKeys(rejected.text, rejected.problems)
  );
}

/**
 * Lets the seed fill the keys a partial config leaves unset. Returns the plan with the config
 * seed's `managedKeys` widened to those keys, or null after printing the problems that remain.
 */
function fillPartialConfig(
  actions: Action[],
  existing: { text: string; problems: string[] },
): Action[] | null {
  const seed = actions.find(
    (action): action is SeedAction =>
      action.kind === 'seed' && action.dest === CONFIG_DEST,
  );
  const fill = seed ? planConfigFill(existing.text, seed.content) : null;
  if (!seed || !fill || fill.problems.length > 0) {
    printConfigProblems(fill?.problems ?? existing.problems);
    return null;
  }
  return actions.map((action) =>
    action === seed
      ? {
          ...seed,
          managedKeys: [...(seed.managedKeys ?? []), ...fill.missingKeys],
        }
      : action,
  );
}

/** Runs the full install: detect, choose, plan, preview, apply. */
export async function init(dir: string, flags: Flags): Promise<number> {
  const root = resolve(dir);
  let ctx: Ctx;
  let registry: Registry;
  const partialConfig = readRejectedConfig(root);
  try {
    ctx = detect(root);
    preflight(root, ctx);
    if (partialConfig && !isFillable(partialConfig, ctx)) {
      printConfigProblems(partialConfig.problems);
      return EXIT.badConfig;
    }
    registry = buildRegistry(root, ctx.claude.houseConfig, MODULES);
  } catch (e) {
    if (e instanceof HouseError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

  ui.intro(`houserules ${flags.kitVersion} — init`);
  ui.note(ui.profileCard(ctx), 'Detected');

  // Already installed? Default to the previously chosen modules.
  const installed = ctx.claude.manifest;
  const optionOverrides = parseModuleOptionFlags(flags.moduleOption ?? []);
  const optionsFor = (ids: string[]) =>
    resolveModuleOptions(
      registry,
      ids,
      ctx.claude.houseConfig?.moduleOptions,
      optionOverrides,
    );
  const closeOver = (
    ids: readonly string[],
    chosen: Record<string, string[]> = {},
  ) =>
    closeSelection(registry, ids, {
      persisted: ctx.claude.houseConfig?.moduleOptions,
      chosen: { ...optionOverrides, ...chosen },
      packageManager: ctx.packageManager?.name,
    });
  let moduleIds: string[];
  let closure: RequirementClosure;
  try {
    const installedIds = installedModuleIds(ctx.claude.houseConfig, installed);
    moduleIds = installedIds?.length
      ? resolveModuleIds(
          ctx,
          registry,
          flags.modules ? flags.modules : installedIds.join(','),
        )
      : resolveModuleIds(ctx, registry, flags.modules);
    closure = closeOver(moduleIds).closure;
    assertNotWithdrawn(closure, withdrawnModuleIds(flags.modules));
    moduleIds = closure.moduleIds;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  if (installed) {
    ui.message(
      `This repo already has houserules v${installed.kitVersion}. init re-plans with your existing module set as the default. For a plain refresh of kit-owned files use: npx houserules update`,
    );
  }

  const initiallyRequired = closure.requiredBy;
  let targets = ctx.targets;
  let moduleOptions = optionsFor(moduleIds);
  try {
    if (!flags.yes) {
      moduleIds = await ui.selectModules(
        registry.modules,
        ctx,
        moduleIds,
        closure.requiredBy,
        (ids) => closeOver(ids).closure.moduleIds,
      );
      targets = await ui.confirmTargets(targets);
      moduleOptions = optionsFor(moduleIds);
      const enabled = registry.modules.filter((m) => moduleIds.includes(m.id));
      moduleOptions = await ui.selectModuleOptions(enabled, moduleOptions);
    }
    const selection = closeOver(
      moduleIds.filter((id) => initiallyRequired[id] === undefined),
      moduleOptions,
    );
    closure = selection.closure;
    moduleIds = closure.moduleIds;
    moduleOptions = selection.moduleOptions;
  } catch (e) {
    if (e instanceof HouseError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
  const requiredNote = requiredByNote(closure);
  if (requiredNote !== null) ui.message(requiredNote);

  const answers: Answers = {
    moduleIds,
    targets,
    seedChangesetConfig: true,
    moduleOptions,
  };
  if (
    !flags.yes &&
    hasModule(moduleIds, 'changesets') &&
    !ctx.changesets.configExists
  ) {
    answers.seedChangesetConfig = await ui.confirm(
      'No .changeset/config.json — seed a default one?',
    );
  }

  let planResult: PlanResult;
  try {
    let actions = buildPlan(ctx, answers, registry);
    if (partialConfig) {
      const filled = fillPartialConfig(actions, partialConfig);
      if (filled === null) return EXIT.badConfig;
      actions = filled;
    }
    planResult = computeEffects(root, actions, {
      manifest: installed,
      plugins: registry.plugins,
      shouldPlanPrepare: true,
      ...configOwnership(ctx.claude.houseConfig),
    });
  } catch (e) {
    if (e instanceof HouseError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

  // `plugins` is passed so a missing payload is attributed to its plugin rather than
  // reported as a bare path. Unlike `update`, init refuses rather than installing what it
  // can: `apply` records the chosen module ids in the manifest regardless of which effects
  // ran, so a partial first install would claim modules whose files were never written.
  if (planResult.brokenPlugins.length) {
    for (const problem of planResult.brokenPlugins) ui.message(problem.message);
    ui.outro('Nothing written — build the plugin above, then re-run init.');
    return 1;
  }

  ui.note(
    [
      ui.renderPreview(planResult),
      ...renderPrepareScriptPlan(planResult.prepareScript),
    ]
      .filter(Boolean)
      .join('\n'),
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
    plugins: registry.plugins,
  });

  ui.written(written);
  ui.nextSteps(planResult.advisories);
  ui.outro('Installed. Validate any time with: npx houserules doctor');
  return 0;
}
