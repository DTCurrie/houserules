import { join } from 'node:path';

import { readJson } from '../../../payload-dist/scripts/lib/workspaces.mjs';
import { apply } from '../../apply.js';
import type { Flags } from '../../cli-contract.js';
import {
  computeDrift,
  driftedFiles,
  FIXABLE,
  type DriftReport,
} from '../../core/drift.js';
import { TargetRepo } from '../../core/fs-target.js';
import { MANIFEST_PATH, type KitManifest } from '../../core/manifest.js';
import type { Ctx } from '../../detect.js';
import { buildPlan, computeEffects, computePrune } from '../../plan.js';
import type { CheckResult, Finding } from './finding.js';

const DRIFT_EXPLANATIONS: Record<string, string> = {
  missing: 'missing — `doctor --fix` recreates it',
  stale: 'stale — the kit has a newer version; `update` refreshes it',
  yours: 'yours — you edited it; kept unless --force',
  'no-marker': 'managed markers removed — `doctor --fix` re-inserts the block',
  orphaned:
    'orphaned — no enabled module produces it; `--fix --prune` removes it',
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
 */
export function reconcileDrift(
  root: string,
  ctx: Ctx,
  flags: Flags,
): DriftCheck {
  const findings: Finding[] = [];
  const manifest = ctx.claude.manifest;
  let drift: DriftReport = { files: [] };

  if (!manifest) return { drift, findings, readouts: [] };

  const targets = ctx.claude.kitConfig?.targets?.length
    ? ctx.claude.kitConfig.targets
    : ctx.targets;
  const moduleIds = manifest.modules ?? ['core'];
  const planAgainst = (against: KitManifest | null, force: boolean) =>
    computeEffects(
      root,
      buildPlan(ctx, { moduleIds, targets, seedChangesetConfig: false }),
      { manifest: against, force },
    );

  try {
    const planResult = planAgainst(manifest, flags.force);
    drift = computeDrift(
      root,
      planResult.effects,
      computePrune(root, {
        manifest,
        plannedDests: planResult.plannedDests,
      }),
    );

    if (flags.fix) {
      const fixable = new Set(
        driftedFiles(drift)
          .filter(
            (f) =>
              FIXABLE.includes(f.status) ||
              (f.status === 'yours' && flags.force),
          )
          .map((f) => f.path),
      );
      if (fixable.size) {
        apply(
          root,
          { ...planResult, prune: null },
          {
            kitVersion: flags.kitVersion,
            moduleIds,
            previousManifest: manifest,
            paths: fixable,
          },
        );
      }
      if (flags.prune) {
        const repo = new TargetRepo(root);
        for (const file of drift.files) {
          if (file.status === 'orphaned') repo.remove(file.path);
        }
      }
      // Re-derive against the reconciled tree so the report reflects reality.
      const reconciled = readJson<KitManifest>(join(root, MANIFEST_PATH));
      const after = planAgainst(reconciled, false);
      drift = computeDrift(
        root,
        after.effects,
        computePrune(root, {
          manifest: reconciled,
          plannedDests: after.plannedDests,
        }),
      );
    }
  } catch (e) {
    findings.push({
      level: 'ERROR',
      msg: `could not compute drift: ${(e as Error).message}`,
    });
  }

  for (const file of driftedFiles(drift)) {
    findings.push({
      level: file.status === 'missing' ? 'ERROR' : 'WARN',
      msg: `${file.path}: ${DRIFT_EXPLANATIONS[file.status] ?? file.status}`,
    });
  }

  return { drift, findings, readouts: [] };
}
