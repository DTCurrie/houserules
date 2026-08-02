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
}

/** The `--json` shape. This is a CI contract, asserted in src/__test__/cli.test.ts. */
export function printJsonReport(report: DoctorReport): void {
  const drifted = driftedFiles(report.drift);
  log.json({
    ok: report.exitCode === EXIT.ok,
    exitCode: report.exitCode,
    root: report.root,
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
  // statuses where "what changed" is actionable carry one.
  for (const file of drifted) {
    if (!file.diff) continue;
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
  if (drifted.length && !isFixing) {
    console.log('Run `npx claude-kit doctor --fix` to reconcile.');
  }
}
