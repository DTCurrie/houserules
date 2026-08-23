/**
 * `error` means the checker decided and a finding is a defect.
 *
 * `warn` means the checker found a CANDIDATE and a model still has to rule on it. This is
 * the whole distinction between a mechanical clause and a hybrid one. A rule that says
 * "past 20 to 30 lines, look again" produces candidates, not defects, and shipping those
 * at `error` misreads the clause it is enforcing.
 */
export type Level = 'error' | 'warn';

/**
 * What a checker reports about one location, and how it prints.
 *
 * Two shapes already existed when this was written and neither was sufficient.
 * `@houserules/api`'s `Finding` carries a level but no location, because a doctor check
 * reports about the install rather than about a line. `design-checks.mts` carries a line
 * but no level and no rule id, because it was written for one script that only ever had
 * one severity. A checker that reports a rule-clause violation needs all three: the
 * location so a reader can go there, the level so severity is not guessed, and the clause
 * id so coverage can be verified per clause rather than per checker.
 *
 * This is deliberately NOT the api type. The payload is a copy target that runs on bare
 * node in a user's repo, so it cannot import from a published package at runtime, and the
 * two shapes answer different questions anyway.
 */
export interface Finding {
  /**
   * The clause this violates, not the checker that found it. Several checkers may report
   * the same clause and one checker usually reports several, so keying on the checker
   * makes coverage unverifiable.
   */
  rule: string;
  level: Level;
  /** Repo-relative. Absolute paths leak the author's home directory into shared output. */
  file: string;
  /** Null when the finding is about the file itself, such as a missing file. */
  line: number | null;
  msg: string;
}

/**
 * A checker's whole result, including what it did not look at.
 *
 * `declined` generalises the scope note `design.mts` prints on every run. A checker that
 * hides its own boundary is how a standard gets silently dropped: a reader sees a clean
 * report and concludes the rule is satisfied, when the checker never examined the half
 * that was broken. Every checker states what it skipped, every run, whether or not it
 * found anything.
 */
export interface Report {
  findings: Finding[];
  declined: string[];
}

export function emptyReport(): Report {
  return { findings: [], declined: [] };
}

/**
 * Sorts by file, then line, then rule. Null lines sort ahead of numbered ones, since a
 * finding about the whole file belongs above findings inside it.
 *
 * Stable ordering is not cosmetic here. A checker that emits the same findings in a
 * different order on two runs cannot be diffed between runs, and reproducibility is the
 * property this whole layer exists to provide.
 */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      (a.line ?? -1) - (b.line ?? -1) ||
      a.rule.localeCompare(b.rule),
  );
}

/** True when anything in the report is a decided defect rather than a candidate. */
export function hasErrors(report: Report): boolean {
  return report.findings.some((finding) => finding.level === 'error');
}

/**
 * Exit 1 when the report carries a decided defect, otherwise 0.
 *
 * Warnings never move the exit code. A candidate list that failed a build would force
 * every hybrid clause to become a gate it cannot honestly be.
 */
export function exitCodeFor(report: Report): number {
  return hasErrors(report) ? 1 : 0;
}

function formatLocation(finding: Finding): string {
  return finding.line === null
    ? finding.file
    : `${finding.file}:${finding.line}`;
}

/**
 * One finding per line, `file:line  LEVEL  [rule]  message`, then the declined list.
 *
 * The location leads so the line is clickable in a terminal. The declined section prints
 * even when there are no findings, because that is exactly when a reader is most likely to
 * conclude the rule is fully satisfied.
 */
export function renderReport(report: Report): string {
  const lines = sortFindings(report.findings).map(
    (finding) =>
      `${formatLocation(finding)}  ${finding.level.toUpperCase()}  [${finding.rule}]  ${finding.msg}`,
  );
  if (lines.length === 0) lines.push('No findings.');
  if (report.declined.length > 0) {
    lines.push('', 'Not checked by this checker:');
    for (const item of report.declined) lines.push(`  - ${item}`);
  }
  return lines.join('\n');
}
