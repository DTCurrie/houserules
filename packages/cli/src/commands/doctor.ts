import { resolve } from 'node:path';

import type { Flags } from '../cli-contract.js';
import { EXIT } from '../cli-contract.js';
import { driftedFiles, isLocalEdit, type FileDrift } from '../core/drift.js';
import { detect } from '../detect.js';
import { checkAgentToolScope } from './doctor/agent-tool-scope.js';
import { checkConfigValidity } from './doctor/config-validity.js';
import { reconcileDrift } from './doctor/drift-reconcile.js';
import { checkEnvironment } from './doctor/environment.js';
import type { CheckResult, Finding } from '@houserules/api';
import {
  printJsonReport,
  printTextReport,
  type DoctorReport,
} from './doctor/findings-report.js';
import { checkInstallIntegrity } from './doctor/install-integrity.js';
import { checkModuleHealth } from './doctor/module-health.js';
import { checkPluginRegistration } from './doctor/plugin-registration.js';
import { checkReferenceReachability } from './doctor/reference-reachability.js';
import { checkResidentSurface } from './doctor/resident-surface.js';
import { checkSettingsWiring } from './doctor/settings-wiring.js';

/**
 * Drift entries that move the exit code. A local edit never does, whether it is a settled
 * `yours` or a `conflict` houserules has also moved on from. Neither is overwritten without
 * `--force`, so counting them would leave doctor permanently red on an install that is
 * working exactly as intended.
 */
export function blockingDrift(drifted: FileDrift[]): FileDrift[] {
  return drifted.filter((file) => !isLocalEdit(file));
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
 * config the schema rejects. Drift you caused yourself never moves the exit code, because
 * there is no way to acknowledge a deliberate edit and it would leave doctor permanently
 * red on an install working as intended. A settled `yours` edit is a readout. A
 * `conflict`, where houserules shipped a newer version of a file you edited, is a warning
 * with a diff, since that one leaves you a merge to make.
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
    checkAgentToolScope(root),
    checkReferenceReachability(root, ctx),
    checkEnvironment(ctx),
    checkInstallIntegrity(root, ctx, flags.kitVersion, config.registry),
    config,
    checkSettingsWiring(root, ctx),
    checkModuleHealth(root, ctx, config.registry),
    checkPluginRegistration(root, ctx),
  ];
  // Non-null past the gate above: a null registry only accompanies a config problem,
  // and that path already returned.
  const { drift, ...driftCheck } = reconcileDrift(
    root,
    ctx,
    flags,
    config.registry!,
  );
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
