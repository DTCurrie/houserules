export type Level = 'ERROR' | 'WARN';

export interface Finding {
  level: Level;
  msg: string;
}

/**
 * What one check concluded. `readouts` are context lines printed on every run that never
 * move the exit code. `findings` are the ERROR/WARN entries that can.
 */
export interface CheckResult {
  findings: Finding[];
  readouts: string[];
}
