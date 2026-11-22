export type Level = 'ERROR' | 'WARN';

export interface Finding {
  level: Level;
  msg: string;
  /**
   * A stable name for the finding, carried into `doctor --json` so a script or a test can
   * match it without parsing `msg`. Absent on findings that predate it.
   */
  id?: string;
}

/**
 * What one check concluded. `readouts` are context lines printed on every run that never
 * move the exit code. `findings` are the ERROR/WARN entries that can.
 */
export interface CheckResult {
  findings: Finding[];
  readouts: string[];
}
