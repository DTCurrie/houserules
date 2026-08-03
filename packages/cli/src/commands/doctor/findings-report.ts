import { EXIT } from '../../cli-contract.js';
import { driftedFiles, type DriftReport } from '../../core/drift.js';
import * as log from '../log.js';
import type { Finding } from './finding.js';

export interface DoctorReport {
  root: string;
  exitCode: number;
  configProblems: string[];
  findings: Finding[];
  readouts: string[];
  drift: DriftReport;
  blockingCount: number;
  /**
   * The config was rejected, so every check after it was skipped. Without this an empty
   * `drift` would read as "nothing drifted" when it means "drift was never computed".
   */
  configBlocked: boolean;
}

/** The `--json` shape. This is a CI contract, asserted in src/__test__/cli.test.ts. */
export function printJsonReport(report: DoctorReport): void {
  const drifted = driftedFiles(report.drift);
  log.json({
    ok: report.exitCode === EXIT.ok,
    exitCode: report.exitCode,
    root: report.root,
    configBlocked: report.configBlocked,
    configProblems: report.configProblems,
    findings: report.findings,
    readouts: report.readouts,
    drift: report.drift.files,
    counts: {
      errors: report.findings.filter((f) => f.level === 'ERROR').length,
      warnings: report.findings.filter((f) => f.level === 'WARN').length,
      drifted: drifted.length,
      blocking: report.blockingCount,
    },
  });
}

export function printTextReport(report: DoctorReport, isFixing: boolean): void {
  const drifted = driftedFiles(report.drift);
  const errors = report.findings.filter((f) => f.level === 'ERROR');
  const warns = report.findings.filter((f) => f.level === 'WARN');

  for (const line of report.readouts) console.log(`· ${line}`);
  for (const f of report.findings)
    console.log(`${f.level === 'ERROR' ? '✗ ERROR' : '! WARN '}  ${f.msg}`);
  // Diffs come after the finding list so the summary stays scannable. Only the
  // statuses where "what changed" is actionable carry one. A settled `yours` edit is
  // reported as a readout, so re-printing its diff every run is noise.
  for (const file of drifted) {
    if (!file.diff || file.status === 'yours') continue;
    console.log(`\n--- ${file.path} (${file.status})`);
    console.log(
      file.diff
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    );
  }
  console.log(
    report.findings.length
      ? `\n${errors.length} error(s), ${warns.length} warning(s).`
      : '✓ kit installation healthy — no findings.',
  );
  if (report.configBlocked) {
    console.log(
      'Every other check was skipped: they all read .claude/kit.config.json, and a config the schema rejects cannot be trusted.',
    );
    console.log('Fix the problems above, then run doctor again.');
    return;
  }
  // Gated on blocking drift, not on drift at all. A local edit is never reconciled by a
  // bare `--fix`, so offering it there contradicts the healthy verdict just printed.
  if (report.blockingCount && !isFixing) {
    console.log('Run `npx claude-kit doctor --fix` to reconcile.');
  }
}
