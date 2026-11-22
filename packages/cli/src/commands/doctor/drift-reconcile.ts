import { installedModuleIds } from '../../installed-modules.js';
import { join } from 'node:path';

import { readJson } from '@houserules/payload/workspaces';
import { apply } from '../../apply.js';
import type { Flags } from '../../cli-contract.js';
import {
  computeDrift,
  driftedFiles,
  FIXABLE,
  FORCE_ONLY,
  type DriftReport,
} from '../../core/drift.js';
import { MANIFEST_PATH, type HouseManifest } from '@houserules/api/internal';
import type { Ctx } from '../../detect.js';
import { formatterMangleHint } from '../../modules/formatter-mangle.js';
import {
  classifiedDests,
  ignoredUnejectedDests,
  localEditHints,
} from '../../core/local-edit-hints.js';
import { resolveModuleOptions } from '../../module-options.js';
import {
  buildPlan,
  computeEffects,
  computePrune,
  configOwnership,
} from '../../plan.js';
import type { PlanResult } from '../../plan.js';
import type { Registry } from '../../plugin-registry.js';
import { findRetired, retiredModuleAdvice } from '../../retired-modules.js';
import type { CheckResult, Finding } from '@houserules/api';

const CONFLICT_WITH_FORCE =
  'you edited it and houserules shipped a newer version since. Merge by hand, or `--fix --force` to take houserules copy';
const CONFLICT_EJECTED =
  'you edited it and houserules shipped a newer version since. It is ejected, so merge by hand';

const DRIFT_EXPLANATIONS: Record<string, string> = {
  missing: 'missing. `doctor --fix` recreates it',
  stale: 'stale. houserules has a newer version, and `update` refreshes it',
  conflict: CONFLICT_WITH_FORCE,
  'no-marker': 'managed markers removed. `doctor --fix` re-inserts the block',
  orphaned:
    'orphaned. No enabled module produces it, and `--fix --prune` removes it',
};

export interface DriftCheck extends CheckResult {
  drift: DriftReport;
}

/**
 * Re-derives the install from the same plan `update` would run, so the two can never
 * disagree, and under `--fix` reconciles what it found before re-deriving against the
 * repaired tree. Drift is a WARN rather than an ERROR, because a drifted install is not
 * a broken one. A MISSING file is the exception: a hook wired to a script that is not
 * there is broken, not merely drifted.
 *
 * @param registry Built once by `checkConfigValidity`, which had to resolve every plugin to
 *   prove they load. Reused here rather than rebuilt, so one doctor run resolves each plugin
 *   exactly once.
 */
export function reconcileDrift(
  root: string,
  ctx: Ctx,
  flags: Flags,
  registry: Registry,
): DriftCheck {
  const findings: Finding[] = [];
  const manifest = ctx.claude.manifest;
  let drift: DriftReport = { files: [] };
  let ignored: ReadonlySet<string> = new Set();
  let tracked: ReadonlySet<string> = new Set();

  if (!manifest) return { drift, findings, readouts: [] };

  const targets = ctx.claude.houseConfig?.targets?.length
    ? ctx.claude.houseConfig.targets
    : ctx.targets;
  const moduleIds = installedModuleIds(ctx.claude.houseConfig, manifest) ?? [
    'core',
  ];
  const retired = findRetired(moduleIds, registry);
  if (retired.length)
    return {
      drift,
      findings: [
        {
          level: 'ERROR',
          msg:
            `install uses ${retired.length === 1 ? 'a module' : 'modules'} that moved into ${retired.length === 1 ? 'a plugin' : 'plugins'}:\n` +
            retiredModuleAdvice(retired),
        },
      ],
      readouts: [],
    };
  const moduleOptions = resolveModuleOptions(
    registry,
    moduleIds,
    ctx.claude.houseConfig?.moduleOptions,
  );
  const ownership = configOwnership(ctx.claude.houseConfig);
  const planAgainst = (against: HouseManifest | null, force: boolean) =>
    computeEffects(
      root,
      buildPlan(
        ctx,
        { moduleIds, targets, seedChangesetConfig: false, moduleOptions },
        registry,
      ),
      {
        manifest: against,
        force,
        plugins: registry.plugins,
        ...ownership,
      },
    );

  try {
    const planResult = planAgainst(manifest, flags.force);
    // A plugin with no built payload is an ERROR finding naming that plugin, not a thrown
    // HouseError reported as "could not compute drift: <absolute path>". The rest of the drift
    // report still renders, and `--fix` still applies, because the broken plugin's dests are
    // folded into `plannedDests` and so appear in neither the drift set nor the prune set.
    for (const problem of planResult.brokenPlugins)
      findings.push({ level: 'ERROR', msg: problem.message });
    drift = driftReportFor(root, planResult, manifest, ownership.ejected);
    ignored = ignoredUnejectedDests(ctx, planResult.effects, ownership.ejected);
    const trackedDests = classifiedDests(
      root,
      ctx,
      planResult.effects,
      ownership.ejected,
    );
    tracked = new Set(trackedDests);
    if (trackedDests.length)
      findings.push({
        id: 'payload-tracked',
        level: 'WARN',
        msg: `${trackedDests.length} installed payload file(s) are committed but now listed in .claude/.gitignore: ${trackedDests.join(', ')}. Untrack them, keeping them on disk: npx houserules update`,
      });

    let settledManifest: HouseManifest | null = manifest;
    let settledPlanResult = planResult;

    if (flags.fix) {
      applyFixableChanges(
        root,
        planResult,
        drift,
        flags,
        manifest,
        moduleIds,
        registry,
        ownership.ejected,
      );
      // Re-derive against the reconciled tree so the report reflects reality.
      const reconciled = readJson<HouseManifest>(join(root, MANIFEST_PATH));
      settledManifest = reconciled;
      settledPlanResult = planAgainst(reconciled, false);
      drift = driftReportFor(
        root,
        settledPlanResult,
        reconciled,
        ownership.ejected,
      );
    }

    findings.push(
      ...staleManifestFindings(
        root,
        settledManifest,
        settledPlanResult,
        ownership.ejected,
      ),
    );
  } catch (e) {
    findings.push({
      level: 'ERROR',
      msg: `could not compute drift: ${(e as Error).message}`,
    });
  }

  const { settled, retiredEjected } = classifyDriftFindings(
    root,
    drift,
    findings,
    ownership.ejected,
  );

  return {
    drift,
    findings,
    readouts: [
      ...settledReadout(settled, ignored, tracked),
      ...retiredEjectedReadout(retiredEjected),
    ],
  };
}

/** The drift report for one plan result, prune included, against `manifest`. */
function driftReportFor(
  root: string,
  planResult: PlanResult,
  manifest: HouseManifest | null,
  ejected: ReadonlySet<string>,
): DriftReport {
  return computeDrift(root, planResult.effects, {
    manifest,
    prune: computePrune(root, {
      manifest,
      plannedDests: planResult.plannedDests,
      ejected,
    }),
  });
}

/**
 * A manifest entry naming a dest that is already gone from disk: the earlier repair that
 * deleted it never dropped the receipt, so it reads as installed forever. Distinct from
 * `orphaned`, which `orphanDrift` reports only for a dest still ON disk. `doctor --fix
 * --prune` clears it, via the same `apply()` prune pass that removes an orphaned file.
 */
function staleManifestFindings(
  root: string,
  manifest: HouseManifest | null,
  planResult: PlanResult,
  ejected: ReadonlySet<string>,
): Finding[] {
  return computePrune(root, {
    manifest,
    plannedDests: planResult.plannedDests,
    ejected,
  })
    .deletes.filter((entry) => entry.gone)
    .map((entry) => ({
      level: 'WARN',
      msg: `${entry.dest}: manifest lists it but the file is gone from disk. \`doctor --fix --prune\` removes the stale entry`,
    }));
}

/**
 * Applies the fixable subset of `drift` to disk: a real write for each fixable path, plus,
 * under `--prune`, the deletion pass for every orphaned or already-gone manifest entry.
 * Routed through `apply()` rather than a bare `TargetRepo.remove`, so the manifest receipt
 * for a pruned dest is dropped in the same pass that deletes it. Mutates
 * the filesystem, never the report; the caller re-derives drift against the reconciled tree
 * afterward.
 */
function applyFixableChanges(
  root: string,
  planResult: PlanResult,
  drift: DriftReport,
  flags: Flags,
  manifest: HouseManifest,
  moduleIds: string[],
  registry: Registry,
  ejected: ReadonlySet<string>,
): void {
  const fixable = new Set(
    driftedFiles(drift)
      .filter(
        (f) =>
          FIXABLE.includes(f.status) ||
          (flags.force && FORCE_ONLY.includes(f.status)),
      )
      .map((f) => f.path),
  );
  // `force: true` here matches the removal pass this replaces, which pruned every
  // orphaned dest unconditionally. Whether a locally-edited orphan should survive
  // `--prune` without `--force` is a separate question, deliberately left open. An
  // ejected file is never pruned, so `computePrune` keeps it even here.
  const prune = flags.prune
    ? computePrune(root, {
        manifest,
        plannedDests: planResult.plannedDests,
        force: true,
        ejected,
      })
    : null;
  if (fixable.size || prune?.deletes.length) {
    apply(
      root,
      { ...planResult, prune },
      {
        kitVersion: flags.kitVersion,
        moduleIds,
        previousManifest: manifest,
        paths: fixable,
        plugins: registry.plugins,
      },
    );
  }
}

function driftExplanation(
  status: string,
  path: string,
  ejected: ReadonlySet<string>,
): string {
  if (status === 'conflict' && ejected.has(path)) return CONFLICT_EJECTED;
  return DRIFT_EXPLANATIONS[status] ?? status;
}

/**
 * Classifies every drifted file into a finding, except a settled local edit and an ejected
 * file no enabled module ships, and appends a formatter-mangle hint when the settled count
 * crosses that check's own threshold.
 *
 * @returns The settled paths and the retired ejected paths, so the caller can build the
 *   "context, not a warning" readouts.
 */
function classifyDriftFindings(
  root: string,
  drift: DriftReport,
  findings: Finding[],
  ejected: ReadonlySet<string>,
): { settled: string[]; retiredEjected: string[] } {
  const settled: string[] = [];
  const retiredEjected: string[] = [];
  for (const file of driftedFiles(drift)) {
    if (file.status === 'yours') {
      settled.push(file.path);
      continue;
    }
    if (file.status === 'orphaned' && ejected.has(file.path)) {
      retiredEjected.push(file.path);
      continue;
    }
    findings.push({
      level: file.status === 'missing' ? 'ERROR' : 'WARN',
      msg: `${file.path}: ${driftExplanation(file.status, file.path, ejected)}`,
    });
  }
  for (const file of drift.files) {
    if (!file.defaultMoved) continue;
    findings.push({
      level: 'WARN',
      msg:
        `${file.path}: houserules shipped a new default \`paths:\` for this rule, but ` +
        `the \`paths:\` you set, in the file or in the config's \`rules\`, were kept. Check houserules' CHANGELOG for what changed`,
    });
  }

  const mangleHint = formatterMangleHint(
    root,
    settled.filter((path) => !ejected.has(path)),
    'Run `npx houserules doctor --fix --force` to restore them',
  );
  if (mangleHint) findings.push({ level: 'WARN', msg: mangleHint });

  return { settled, retiredEjected };
}

/**
 * A settled local edit is reported as context rather than as a warning. houserules itself
 * tells you to edit some of what it installs, so warning about the result would leave
 * doctor permanently yellow and bury the drift that does need a decision.
 */
function settledReadout(
  settled: string[],
  ignored: ReadonlySet<string>,
  tracked: ReadonlySet<string>,
): string[] {
  if (!settled.length) return [];
  return [
    `your edits on ${settled.length} houserules file(s), kept as-is: ${settled.join(', ')}`,
    ...localEditHints(settled, ignored, 'npx houserules', tracked),
  ];
}

/**
 * An ejected file whose module is no longer enabled is kept on purpose, so it is context,
 * and no prune is offered: `computePrune` never deletes an ejected file.
 */
function retiredEjectedReadout(retiredEjected: string[]): string[] {
  if (!retiredEjected.length) return [];
  return [
    `ejected file(s) no enabled module ships, kept as yours: ${retiredEjected.join(', ')}`,
  ];
}
