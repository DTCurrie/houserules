import { resolve } from 'node:path';

import type { Flags } from '../cli-contract.js';
import { EXIT } from '../cli-contract.js';
import { driftedFiles, type FileDrift } from '../core/drift.js';
import { detect } from '../detect.js';
import { checkConfigValidity } from './doctor/config-validity.js';
import { reconcileDrift } from './doctor/drift-reconcile.js';
import { checkEnvironment } from './doctor/environment.js';
import type { CheckResult, Finding } from './doctor/finding.js';
import {
  printJsonReport,
  printTextReport,
  type DoctorReport,
} from './doctor/findings-report.js';
import { checkInstallIntegrity } from './doctor/install-integrity.js';
import { checkModuleHealth } from './doctor/module-health.js';
import { checkResidentSurface } from './doctor/resident-surface.js';
import { checkSettingsWiring } from './doctor/settings-wiring.js';

/**
 * Drift entries that move the exit code. `yours` never does. There is no way to
 * acknowledge a deliberate edit, so counting it would leave doctor permanently red on an
 * install that is working exactly as intended.
 */
export function blockingDrift(drifted: FileDrift[]): FileDrift[] {
  return drifted.filter((file) => file.status !== 'yours' && !file.yours);
}

/**
 * The severity rollup, kept pure so the CI contract is testable without a repo on disk.
 *
 * A rejected config outranks everything, because nothing downstream can be trusted when
 * the config itself will not parse.
 */
export function doctorExitCode(args: {
  configProblems: readonly string[];
  findings: readonly Finding[];
  drifted: FileDrift[];
}): number {
  if (args.configProblems.length) return EXIT.badConfig;
  const hasError = args.findings.some((f) => f.level === 'ERROR');
  if (hasError || blockingDrift(args.drifted).length) return EXIT.error;
  return EXIT.ok;
}

/**
 * Validates an installation against reality.
 *
 * @returns Exit 1 on an ERROR (a broken install) or on actionable drift, exit 2 on a
 * config the schema rejects. Drift you caused yourself (`yours`) is reported with a diff
 * but never moves the exit code, because there is no way to acknowledge a deliberate
 * edit and it would leave doctor permanently red on an install working as intended.
 */
export async function doctor(dir: string, flags: Flags): Promise<number> {
  const root = resolve(dir);
  const ctx = detect(root);
  const config = checkConfigValidity(root, ctx);

  // A config the schema rejects is foundational: every check below reads it, and
  // `--fix` would plan writes from it. Report the schema problems and stop, rather
  // than reporting what a config we do not trust claims about the repo.
  if (config.configProblems.length)
    return render(
      {
        root,
        exitCode: EXIT.badConfig,
        configProblems: config.configProblems,
        findings: config.findings,
        readouts: [],
        drift: { files: [] },
        blockingCount: 0,
        configBlocked: true,
      },
      flags,
    );

  // Ordered as the report reads: context first, then the install itself. Drift runs
  // last because under `--fix` it writes, and every check before it must see the tree
  // as the user left it.
  const checks: CheckResult[] = [
    checkResidentSurface(root),
    checkEnvironment(ctx),
    checkInstallIntegrity(root, ctx, flags.kitVersion),
    config,
    checkSettingsWiring(root, ctx),
    checkModuleHealth(root, ctx),
  ];
  const { drift, ...driftCheck } = reconcileDrift(root, ctx, flags);
  checks.push(driftCheck);

  const findings = checks.flatMap((c) => c.findings);
  const readouts = checks.flatMap((c) => c.readouts);
  const drifted = driftedFiles(drift);
  const exitCode = doctorExitCode({
    configProblems: config.configProblems,
    findings,
    drifted,
  });

  return render(
    {
      root,
      exitCode,
      configProblems: config.configProblems,
      findings,
      readouts,
      drift,
      blockingCount: blockingDrift(drifted).length,
      configBlocked: false,
    },
    flags,
  );
}

function render(report: DoctorReport, flags: Flags): number {
  if (flags.json) printJsonReport(report);
  else printTextReport(report, flags.fix);
  return report.exitCode;
}
