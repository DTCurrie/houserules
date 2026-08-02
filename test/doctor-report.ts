import { runCli } from './run.js';

/**
 * `doctor --json` as a queryable object. The shape is a CI contract, so it is written out here
 * rather than inferred, and a change to it should break these types first.
 */
export interface JsonReport {
  ok: boolean;
  exitCode: number;
  root?: string;
  configProblems?: string[];
  findings?: { level: string; msg: string }[];
  readouts?: string[];
  drift: { path: string; status: string; yours?: boolean; diff?: string }[];
  counts: {
    errors?: number;
    warnings?: number;
    drifted: number;
    blocking: number;
  };
}

export function runDoctorJson(root: string, ...extra: string[]): JsonReport {
  return JSON.parse(
    runCli(['doctor', root, '--json', ...extra]).stdout,
  ) as JsonReport;
}

export function driftFor(
  report: JsonReport,
  path: string,
): JsonReport['drift'][number] | undefined {
  return report.drift.find((file) => file.path === path);
}
