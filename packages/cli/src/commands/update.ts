import { renderPrepareScriptPlan } from '../render.js';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  detect,
  trackedLedgerLogs,
  trackedLedgerSurfaces,
  trackedScriptFiles,
  trackedTemplateFiles,
  untrackFromIndex,
} from '../detect.js';
import type { Ctx } from '../detect.js';
import { backupDestFor, ensureBackupDir } from '../core/fs-target.js';
import { ledgerDirFor } from '../core/ledger-dir.js';
import { settingsParseErrorMessage } from '../core/settings-guard.js';
import { assertOptionsRecorded } from '../module-options.js';
import { installedModuleIds } from '../installed-modules.js';
import {
  assertNoRetiredModules,
  resolveRecordedModuleIds,
} from '../retired-modules.js';
import {
  MODULES,
  buildPlan,
  computeEffects,
  computePrune,
  configOwnership,
} from '../plan.js';
import { HouseError } from '../house-error.js';
import {
  closeSelection,
  requiredByNote,
  type RequirementClosure,
} from '../module-requires.js';
import { buildRegistry } from '../plugin-resolver.js';
import {
  parseSettingsText,
  reconcileSettings,
  removeHooksByScript,
  renderSettings,
  validateHouseConfig,
} from '@houserules/api/internal';
import { apply } from '../apply.js';
import { formatterMangleHint } from '../modules/formatter-mangle.js';
import {
  ignoredUnejectedDests,
  localEditHints,
} from '../core/local-edit-hints.js';
import * as ui from '../ui.js';
import { EXIT } from '../cli-contract.js';
import type { Flags } from '../cli-contract.js';
import type { Answers } from '@houserules/api';
import type { PlanResult, PruneResult } from '../plan.js';

// The two dests whose pre-relocation backups sat beside them as `<dest>.bak`. Static on
// purpose: only these ever merged, and globbing `.claude/*.bak` would sweep up files the
// user made themselves.
const LEGACY_BACKUP_DESTS = [
  '.claude/settings.json',
  '.claude/houserules.config.json',
];

interface LegacyBackupMove {
  from: string;
  to: string;
  /** False when a backup already sits at the new location, so the stray file is kept. */
  movable: boolean;
}

/** Pre-relocation `<dest>.bak` files still beside their dest, and where each would go. */
function legacyBackupMoves(root: string): LegacyBackupMove[] {
  const moves: LegacyBackupMove[] = [];
  for (const dest of LEGACY_BACKUP_DESTS) {
    const from = `${dest}.bak`;
    if (!existsSync(join(root, from))) continue;
    const to = backupDestFor(dest);
    moves.push({ from, to, movable: !existsSync(join(root, to)) });
  }
  return moves;
}

/**
 * Moves each movable legacy backup into the backup directory. Runs before apply(), so the
 * pristine pre-kit copy wins over the post-merge bytes backupOnce would otherwise capture
 * on this same run.
 */
function migrateLegacyBackups(root: string, moves: LegacyBackupMove[]): void {
  for (const move of moves) {
    if (!move.movable) {
      ui.message(
        `backups: ${move.from} kept in place, a backup already exists at ${move.to}.`,
      );
      continue;
    }
    ensureBackupDir(root);
    renameSync(join(root, move.from), join(root, move.to));
    ui.message(`backups: moved ${move.from} to ${move.to}.`);
  }
}

function reportWouldMoveBackups(moves: LegacyBackupMove[]): void {
  for (const move of moves) {
    ui.message(
      move.movable
        ? `backups: ${move.from} would move to ${move.to}.`
        : `backups: ${move.from} kept in place, a backup already exists at ${move.to}.`,
    );
  }
}

/** Committed rendered ledgers, or nothing when houserules must not manage that directory. */
function strayLedgerSurfaces(root: string, ctx: Ctx): string[] {
  const dir = ledgerDirFor(ctx);
  return ctx.git.isRepo && dir ? trackedLedgerSurfaces(root, dir) : [];
}

/** Committed ledger `.jsonl` logs, or nothing when houserules must not manage that directory. */
function strayLedgerLogs(root: string, ctx: Ctx): string[] {
  const dir = ledgerDirFor(ctx);
  return ctx.git.isRepo && dir ? trackedLedgerLogs(root, dir) : [];
}

/** Ledger scripts with a log still at the pre-split `.claude/` path, not the ledger dir. */
function legacyLedgerScripts(root: string): string[] {
  const scripts: string[] = [];
  if (
    existsSync(join(root, '.claude/backlog.log')) ||
    existsSync(join(root, '.claude/backlog.jsonl'))
  ) {
    scripts.push('backlog-log.mjs');
  }
  if (
    existsSync(join(root, '.claude/decisions.log')) ||
    existsSync(join(root, '.claude/decisions.jsonl'))
  ) {
    scripts.push('decision-log.mjs');
  }
  return scripts;
}

// The rename happens on the first ledger command, not during update, and the markdown only
// once render runs. Without this message a migrating repo updates and finds .claude/ledgers/
// empty with nothing telling them what to run.
function showLegacyLedgerHint(root: string): void {
  for (const script of legacyLedgerScripts(root)) {
    ui.message(
      `ledgers: .claude/scripts/${script} still has a log at the old .claude/ path. Run \`node .claude/scripts/${script} list\` to move it into .claude/ledgers/, then \`node .claude/scripts/${script} render\` to write the markdown.`,
    );
  }
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
      `${advisories.length} post-install next step${advisories.length === 1 ? '' : 's'} — see: npx houserules update --next-steps`,
    );
}

/** Reports, without touching git, how many of `paths` a real run would untrack. */
function reportWouldUntrack(
  paths: string[],
  category: string,
  noun: string,
  tail = '',
): void {
  if (paths.length)
    ui.message(
      `${category}: ${paths.length} committed ${noun} would be untracked from git (kept on disk).${tail}`,
    );
}

/** Untracks `paths` from the git index, keeping the bytes on disk, and reports the count. */
function untrackAndReport(
  root: string,
  paths: string[],
  category: string,
  noun: string,
  tail = '',
): number {
  const count =
    paths.length && untrackFromIndex(root, paths) ? paths.length : 0;
  if (count)
    ui.message(
      `${category}: untracked ${count} ${noun} from git — kept on disk. Commit the staged removal to finish.${tail}`,
    );
  return count;
}

/**
 * Why the kept files differ, and how to see it for yourself.
 *
 * A hash mismatch is the only evidence `update` has, and on its own it reads as an
 * accusation. Without the diff the user cannot tell a formatter rewrite from a real edit,
 * which leaves `--force` as the only lever and no reason to trust it.
 */
function showLocalEdits(
  root: string,
  dests: string[],
  ignored: ReadonlySet<string>,
  ejected: ReadonlySet<string>,
): void {
  if (!dests.length) return;
  ui.message(
    `${dests.length} file(s) differ from what houserules last wrote, so they were kept. See what changed: npx houserules doctor --json, where every drift entry carries a diff.`,
  );
  const hints = localEditHints(dests, ignored, 'npx houserules');
  if (hints.length) ui.message(hints.join('\n'));
  const hint = formatterMangleHint(
    root,
    dests.filter((dest) => !ejected.has(dest)),
    'Run `npx houserules update --force` to restore them',
  );
  if (hint) ui.message(hint);
}

/**
 * Resolves the recorded module ids against the registry, gates on a retired module or an
 * unrecorded option, and computes the plan. Both gates run before any plan exists, so
 * `computePrune` can never see a plan that is missing a module's files: continuing past
 * either would delete them and look identical to a deliberate removal.
 *
 * @throws HouseError from any of the gates or from `computeEffects` itself, for the caller
 *   to report and exit 1 on.
 */
function resolveUpdatePlan(
  root: string,
  ctx: Ctx,
  registry: ReturnType<typeof buildRegistry>,
  manifest: Ctx['claude']['manifest'],
  targets: Ctx['targets'],
  flags: Flags,
): {
  planResult: PlanResult;
  updateModuleIds: string[];
  closure: RequirementClosure;
} {
  const recordedModuleIds = installedModuleIds(
    ctx.claude.houseConfig,
    manifest,
  ) ?? ['core'];
  // Resolution runs first. A pre-split manifest records bare ids that the registry no longer
  // answers to, and buildPlan matches on the registered id, so leaving them bare would drop
  // every plugin module's actions and prune its files. The gate runs on the resolved ids, and
  // an id nothing supplies survives resolution unchanged, so it is still reported.
  const resolvedModuleIds = resolveRecordedModuleIds(
    recordedModuleIds,
    registry,
  );
  assertNoRetiredModules(resolvedModuleIds, registry);
  // Same placement rule as the retired-module gate above: before any plan exists, so the
  // prune below can never be computed from a fallback selection the user never chose.
  if (!flags.force) {
    assertOptionsRecorded(
      registry,
      resolvedModuleIds,
      ctx.claude.houseConfig?.moduleOptions,
    );
  }
  // A requirement the recorded set lacks is installed here. It closes before any plan exists
  // for the same reason as the gates above, and an unmet one throws with nothing written.
  const { closure, moduleOptions } = closeSelection(
    registry,
    resolvedModuleIds,
    {
      persisted: ctx.claude.houseConfig?.moduleOptions,
      chosen: {},
      packageManager: ctx.packageManager?.name,
    },
  );
  const updateModuleIds = closure.moduleIds;
  const answers: Answers = {
    moduleIds: updateModuleIds,
    targets,
    seedChangesetConfig: false,
    moduleOptions,
  };
  const planResult = computeEffects(root, buildPlan(ctx, answers, registry), {
    manifest,
    force: flags.force,
    plugins: registry.plugins,
    shouldPlanPrepare: !flags.sync,
    ...configOwnership(ctx.claude.houseConfig),
  });
  return { planResult, updateModuleIds, closure };
}

/**
 * Folds a hook-script removal into `planResult.settingsPlan`, so settings.json is written
 * once and never clobbers a user hook.
 */
function foldRemovedHooksSettings(
  planResult: PlanResult,
  ctx: Ctx,
  removedScripts: string[],
): void {
  const base = planResult.settingsPlan
    ? parseSettingsText(planResult.settingsPlan.text!)
    : (ctx.claude.settings ?? {});
  const { merged, changes } = removeHooksByScript(base, removedScripts);
  if (!changes.length) return;
  planResult.settingsPlan ??= {
    dest: '.claude/settings.json',
    existedBefore: ctx.claude.settingsExists,
    changes: [],
  };
  planResult.settingsPlan.text = renderSettings(merged);
  planResult.settingsPlan.changes.push(...changes);
}

/**
 * Reconciles the recorded settings signature against what the CURRENT modules declare,
 * dropping a still-recognizable houserules hook entry that nothing declares anymore even
 * when its script survives on disk (a module rewiring its hook, not retiring the file
 * `foldRemovedHooksSettings` above already handled). Folds into the same single write.
 */
function foldReconciledSettings(
  planResult: PlanResult,
  ctx: Ctx,
  manifest: Ctx['claude']['manifest'],
): void {
  const base = planResult.settingsPlan
    ? parseSettingsText(planResult.settingsPlan.text!)
    : (ctx.claude.settings ?? {});
  const { merged, dropped } = reconcileSettings(
    base,
    planResult.fragments,
    manifest?.settings,
  );
  if (!dropped.length) return;
  planResult.settingsPlan ??= {
    dest: '.claude/settings.json',
    existedBefore: ctx.claude.settingsExists,
    changes: [],
  };
  planResult.settingsPlan.text = renderSettings(merged);
  planResult.settingsPlan.changes.push(
    ...dropped.map(({ event, matcher, script }) => ({
      kind: 'remove-hook' as const,
      detail: `${event}${matcher ? `(${matcher})` : ''}: ${script}`,
    })),
  );
}

/** What one update run did, for `--sync` to fold into its single line. */
interface UpdateOutcome {
  code: number;
  /** Files written or deleted, the manifest included. A dry run counts what it would write. */
  written: number;
  /** Locally edited files left as they were, refreshed and retired ones alike. */
  kept: number;
  /** How many of the kept files are ignored and not ejected, so `eject` could keep them. */
  keptIgnored?: number;
  /** The first line of the message that failed the run, when it failed. */
  failure?: string;
}

function failed(code: number, message: string): UpdateOutcome {
  console.error(message);
  return {
    code,
    written: 0,
    kept: 0,
    failure: message.split('\n').find((line) => line.trim()) ?? message,
  };
}

/**
 * Refreshes kit-owned files to houserules version. Local edits are honored, so a manifest
 * hash mismatch skips the file unless `--force`. Files and hooks the current houserules no
 * longer ships are pruned when they are kit-owned and unmodified. Genuinely-new default
 * modules are advertised, never auto-enabled.
 *
 * With `flags.sync` the run is unattended: see {@link syncUpdate}.
 */
export async function update(dir: string, flags: Flags): Promise<number> {
  if (flags.sync) return syncUpdate(dir, flags);
  return (await runUpdate(resolve(dir), flags)).code;
}

const SYNC_PREFIX = '[houserules]';

/**
 * `update --sync`, run from a hook or the `prepare` script where nobody is watching. It
 * plans, writes, and prunes as a plain update does, but answers no prompt, never touches the
 * git index, and prints at most one line on stdout. Every path, a thrown error included,
 * exits 0, because a non-zero exit there would fail a dependency install or a session start.
 */
async function syncUpdate(dir: string, flags: Flags): Promise<number> {
  if (flags.force) {
    writeSyncLine(
      `${SYNC_PREFIX} --sync never overwrites local edits, so it refuses --force. Nothing was written. Run \`houserules update --force\` by hand instead.`,
    );
    return EXIT.ok;
  }
  const line = await withOutputSilenced(async () => {
    try {
      return syncLine(
        await runUpdate(resolve(dir), { ...flags, yes: true }),
        flags,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `${SYNC_PREFIX} sync failed: ${message.split('\n')[0]}`;
    }
  });
  if (line) writeSyncLine(line);
  return EXIT.ok;
}

/** The one line a sync run prints, or null when it changed nothing and nothing failed. */
function syncLine(outcome: UpdateOutcome, flags: Flags): string | null {
  if (outcome.failure !== undefined)
    return `${SYNC_PREFIX} sync failed: ${outcome.failure}`;
  if (!outcome.written) return null;
  const counts = `${outcome.written} ${flags.dryRun ? 'to write' : 'written'}, ${outcome.kept} kept (edited)`;
  const hint = outcome.keptIgnored ? ', run houserules doctor' : '';
  return flags.dryRun
    ? `${SYNC_PREFIX} dry run, would sync to ${flags.kitVersion}: ${counts}${hint}`
    : `${SYNC_PREFIX} synced to ${flags.kitVersion}: ${counts}${hint}`;
}

function writeSyncLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Runs `body` with every write to stdout and stderr dropped, clack's included, since a hook's
 * output lands in the user's session. Restores both streams on every path.
 */
async function withOutputSilenced<TResult>(
  body: () => Promise<TResult>,
): Promise<TResult> {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const drop = ((...args: unknown[]): boolean => {
    const callback = args.find((arg) => typeof arg === 'function');
    if (callback) (callback as () => void)();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = drop;
  process.stderr.write = drop;
  try {
    return await body();
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

async function runUpdate(root: string, flags: Flags): Promise<UpdateOutcome> {
  const ctx = detect(root);
  const configPath = join(root, '.claude', 'houserules.config.json');
  if (existsSync(configPath)) {
    // A config the schema rejects cannot be trusted to plan from, so nothing is computed.
    const configProblems = validateHouseConfig(
      readFileSync(configPath, 'utf8'),
    );
    if (configProblems.length) {
      return failed(
        EXIT.badConfig,
        configProblems
          .map((problem) => `houserules.config.json: ${problem}`)
          .join('\n'),
      );
    }
  }
  const registry = buildRegistry(root, ctx.claude.houseConfig, MODULES);
  const manifest = ctx.claude.manifest;
  if (!manifest && !installedModuleIds(ctx.claude.houseConfig, null)) {
    return failed(
      EXIT.error,
      'No .claude/houserules.manifest.json — this repo has no houserules install to update. Run: npx houserules init',
    );
  }
  const settingsError = settingsParseErrorMessage(ctx);
  if (settingsError) return failed(EXIT.error, settingsError);

  const installedLabel = manifest
    ? `v${manifest.kitVersion}`
    : 'unknown, no manifest';
  ui.intro(
    `houserules ${flags.kitVersion} — update (installed: ${installedLabel})`,
  );

  // Targets come from the user-edited houserules.config.json when present: config is
  // the contract. Detection is only the fallback.
  const targets = ctx.claude.houseConfig?.targets?.length
    ? ctx.claude.houseConfig.targets
    : ctx.targets;

  let planResult: PlanResult;
  let updateModuleIds: string[];
  let closure: RequirementClosure;
  try {
    ({ planResult, updateModuleIds, closure } = resolveUpdatePlan(
      root,
      ctx,
      registry,
      manifest,
      targets,
      flags,
    ));
  } catch (e) {
    if (e instanceof HouseError) return failed(EXIT.error, e.message);
    throw e;
  }

  // A broken plugin's missing payload is reported against that plugin, but every other
  // module's plan still renders and applies below. The command still fails, since the
  // broken plugin's files were not refreshed.
  for (const problem of planResult.brokenPlugins) ui.message(problem.message);
  const hasBrokenPlugins = planResult.brokenPlugins.length > 0;
  const brokenFailure = planResult.brokenPlugins[0]?.message.split('\n')[0];

  // The hook removal folds into the same settings write the additive merge produces, so
  // settings.json is written once and never clobbers a user hook.
  const prune: PruneResult = computePrune(root, {
    manifest,
    plannedDests: planResult.plannedDests,
    force: flags.force,
    ejected: configOwnership(ctx.claude.houseConfig).ejected,
  });
  if (prune.removedScripts.length) {
    foldRemovedHooksSettings(planResult, ctx, prune.removedScripts);
  }

  foldReconciledSettings(planResult, ctx, manifest);

  // init unions new defaults, but update (the path people use) did not.
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

  const requiredNote = requiredByNote(closure);
  if (requiredNote !== null) ui.message(requiredNote);

  ui.note(
    [
      ui.renderPreview(planResult),
      ...renderPrepareScriptPlan(planResult.prepareScript),
    ]
      .filter(Boolean)
      .join('\n'),
    flags.dryRun ? 'Update plan (dry run)' : 'Update plan',
  );

  const skipped = planResult.effects
    .filter((e) => e.op === 'skip-modified')
    .map((e) => e.action.dest);
  const ejectedDests = configOwnership(ctx.claude.houseConfig).ejected;
  const ignoredDests = ignoredUnejectedDests(
    ctx,
    planResult.effects,
    ejectedDests,
  );
  const keptIgnored = skipped.filter((dest) => ignoredDests.has(dest)).length;
  const skippedUnejected = skipped.filter((dest) => !ejectedDests.has(dest));
  showLocalEdits(root, skipped, ignoredDests, ejectedDests);

  if (prune.deletes.length || prune.kept.length || prune.ejected.length) {
    const lines: string[] = [];
    for (const d of prune.deletes)
      lines.push(
        `- ${d.dest}${d.gone ? ' (already gone — dropped from manifest)' : d.modified ? ' (was locally edited; --force removed it)' : ''}`,
      );
    for (const k of prune.kept)
      lines.push(
        `! ${k} — retired, but locally edited: kept (--force to remove)`,
      );
    for (const ejectedDest of prune.ejected)
      lines.push(
        `! ${ejectedDest} — ejected, and no enabled module ships it: kept`,
      );
    ui.note(lines.join('\n'), 'Prune (retired by houserules version)');
  }
  if (addable.length)
    ui.message(
      `New default module(s) available: ${addable.join(', ')} — enable with: npx houserules modules --modules=${addable.join(',')}`,
    );

  // A git-index migration, not a target-file write, so it lives here rather than in
  // apply(). Computed up front so the dry-run preview reflects it and cannot lie.
  const strayTemplates = ctx.git.isRepo ? trackedTemplateFiles(root) : [];

  // Same migration for .claude/scripts/, skipped when the repo opted in to committing them.
  const commitScripts = ctx.claude.houseConfig?.scripts?.commit === true;
  const strayScripts =
    ctx.git.isRepo && !commitScripts ? trackedScriptFiles(root) : [];

  const backupMoves = legacyBackupMoves(root);

  if (flags.dryRun) {
    reportWouldMoveBackups(backupMoves);
    reportWouldUntrack(strayTemplates, 'templates', 'reference template(s)');
    reportWouldUntrack(strayScripts, 'scripts', 'hook script(s)');
    reportWouldUntrack(
      strayLedgerSurfaces(root, ctx),
      'ledgers',
      'rendered file(s)',
    );
    reportWouldUntrack(
      strayLedgerLogs(root, ctx),
      'ledgers',
      'ledger log(s)',
      ' The GitHub Project is now the durable record, once `projects-sync.mjs push` has run.',
    );
    showLegacyLedgerHint(root);
    showNextSteps(planResult.advisories, flags);
    ui.outro('Dry run — nothing written.');
    return {
      code: hasBrokenPlugins ? EXIT.error : EXIT.ok,
      written: countPendingWrites(planResult, prune),
      kept: skipped.length + prune.kept.length,
      keptIgnored,
      ...(brokenFailure !== undefined && { failure: brokenFailure }),
    };
  }

  migrateLegacyBackups(root, backupMoves);

  const { written, manifest: recorded } = apply(
    root,
    { ...planResult, prune },
    {
      kitVersion: flags.kitVersion,
      // The resolved ids, never the recorded ones. Writing the bare ids back would re-run the
      // migration on every update and leave the manifest disagreeing with the registry forever.
      moduleIds: updateModuleIds,
      previousManifest: manifest,
      plugins: registry.plugins,
    },
  );
  ui.written(written);

  // A sync runs unattended, often inside a dependency install, so it must never stage a
  // removal behind the user's back. The next plain update performs the migration.
  if (!flags.sync) {
    untrackAndReport(
      root,
      strayTemplates,
      'templates',
      'reference template(s)',
    );
    untrackAndReport(root, strayScripts, 'scripts', 'hook script(s)');
    untrackAndReport(
      root,
      strayLedgerSurfaces(root, ctx),
      'ledgers',
      'rendered file(s)',
    );
    untrackAndReport(
      root,
      strayLedgerLogs(root, ctx),
      'ledgers',
      'ledger log(s)',
      ' The record now lives in the GitHub Project once `projects-sync.mjs push` has run.',
    );
  }

  showLegacyLedgerHint(root);
  showNextSteps(planResult.advisories, flags);

  const pruned = prune.deletes.filter((d) => !d.gone).length;
  ui.outro(
    [
      pruned ? `pruned ${pruned} retired file(s)` : '',
      skippedUnejected.length
        ? `${skippedUnejected.length} locally-edited file(s) kept as-is (--force to overwrite)`
        : '',
    ]
      .filter(Boolean)
      .join('; ') || 'Done.',
  );
  // apply() hands back the previous manifest object itself when it left the file as it was.
  const manifestWritten = recorded !== manifest;
  return {
    code: hasBrokenPlugins ? EXIT.error : EXIT.ok,
    written: written.length + (manifestWritten ? 1 : 0),
    kept: skipped.length + prune.kept.length,
    keptIgnored,
    ...(brokenFailure !== undefined && { failure: brokenFailure }),
  };
}

/** The writes and deletes a real run of this plan would make, the manifest left out. */
function countPendingWrites(
  planResult: PlanResult,
  prune: PruneResult,
): number {
  const fileWrites = planResult.effects.filter(
    (effect) => !effect.op.startsWith('skip-') && effect.content !== null,
  ).length;
  const settingsWrite =
    planResult.settingsPlan?.changes.length && planResult.settingsPlan.text
      ? 1
      : 0;
  const prepareWrite =
    planResult.prepareScript?.kind === 'add' ||
    planResult.prepareScript?.kind === 'append'
      ? 1
      : 0;
  return fileWrites + prune.deletes.length + settingsWrite + prepareWrite;
}
