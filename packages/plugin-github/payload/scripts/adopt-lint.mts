#!/usr/bin/env node
/**
 * Checks backlog-adopt's structural invariants, offline.
 *
 * `backlog-adopt` reads the live issue over the network, and this checker never does: it
 * reads only the local backlog ledger, the local board-index cache a `pull` last wrote, and
 * `houserules.config.json`. That is a deliberate narrowing of what the skill's prose promises,
 * not the whole of it. See `DECLINED` for the half this cannot answer.
 *
 * - No two local entries claim the same GitHub issue. The skill's own guard reads the
 *   `<!-- houserules:entry: -->` marker on the LIVE issue body, which this cannot fetch, so this
 *   checks the local half of the same invariant: the ledger itself never records two entries
 *   against one issue number. A pair here means an issue was adopted twice.
 * - An adopted entry's recorded title still matches the title `board-projection.mjs` cached
 *   for it at the last `pull`. That cache can be stale, so this is a candidate, not a defect.
 * - The configured targets resolve unambiguously: no two share a `label` a GitHub label could
 *   match, and no two `pathPrefix` values overlap so one repo path could resolve to either.
 *
 * Usage: adopt-lint.mjs
 * Exit codes: 0 clean, 1 a decided defect.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { loadConfigSafe, repoRoot } from '@houserules/payload/config';
import type { ConfigTarget } from '@houserules/payload/config';
import {
  ledgerDir,
  ledgerPath,
  readLog,
  relativeToRoot,
} from '@houserules/payload/entry-ledger';
import { loadIndex } from '@houserules/payload/ledger-index';
import type { LedgerIndex } from '@houserules/payload/ledger-index';
import {
  emptyReport,
  exitCodeFor,
  renderReport,
  type Report,
} from '@houserules/payload/findings';

const DECLINED = [
  'whether the live issue body carries the adoption marker, which only a call to GitHub can answer',
  'whether an unadopted issue is a genuine duplicate of an existing entry, a judgment for a person',
  'label and path resolution for one specific issue, since that needs the issue itself',
];

/** One backlog-ledger line, narrowed to the fields this checker reads. */
export interface AdoptRecord {
  id: string;
  action: string;
  title?: string;
  issue?: number;
}

/**
 * `add` records that carry an `issue`, the ones `backlog-adopt` wrote.
 *
 * A later record on the same id (a `move` or an `update`) never sets `issue`, so the birth
 * record is the only one this needs.
 */
function adoptedRecords(records: readonly AdoptRecord[]): AdoptRecord[] {
  return records.filter(
    (record) => record.action === 'add' && record.issue !== undefined,
  );
}

/**
 * Flags a GitHub issue number claimed by more than one local backlog entry.
 *
 * The live marker is what `backlog-adopt` reads to refuse a second adoption of the same issue,
 * and this cannot see that marker. Two ledger entries against one issue number is the same
 * defect visible from the local half: the guard did not stop a duplicate.
 */
export function checkDuplicateIssueAdoption(
  file: string,
  records: readonly AdoptRecord[],
): Report {
  const report = emptyReport();
  const byIssue = new Map<number, string[]>();

  for (const record of adoptedRecords(records)) {
    const issue = record.issue as number;
    const ids = byIssue.get(issue) ?? [];
    ids.push(record.id);
    byIssue.set(issue, ids);
  }

  for (const [issue, ids] of byIssue) {
    if (ids.length < 2) continue;
    report.findings.push({
      rule: 'backlog-adopt/duplicate-issue',
      level: 'error',
      file,
      line: null,
      msg: `issue #${issue} is claimed by ${ids.length} backlog entries: ${ids.join(', ')}. backlog-adopt must refuse to adopt an issue twice.`,
    });
  }

  return report;
}

/**
 * Flags an adopted entry whose recorded title no longer matches the title cached for it at
 * the last `pull`.
 *
 * `warn`, not `error`: the cache is a snapshot, not the live issue, so a mismatch is a
 * candidate for a person to confirm against the current issue rather than a decided defect.
 */
export function checkAdoptedTitleDrift(
  file: string,
  records: readonly AdoptRecord[],
  index: LedgerIndex | null,
): Report {
  const report = emptyReport();
  if (index === null) return report;

  const cachedTitleById = new Map(
    index.entries.map((entry) => [entry.id, entry.title]),
  );

  for (const record of adoptedRecords(records)) {
    const cachedTitle = cachedTitleById.get(record.id);
    if (cachedTitle === undefined || cachedTitle === '') continue;
    if (record.title === undefined || record.title === cachedTitle) continue;
    report.findings.push({
      rule: 'backlog-adopt/title-drift',
      level: 'warn',
      file,
      line: null,
      msg: `${record.id} is recorded as "${record.title}", but the issue was last pulled as "${cachedTitle}". Confirm which title is current.`,
    });
  }

  return report;
}

function normalizedLabel(target: ConfigTarget): string | null {
  const label = target.label?.trim().toLowerCase();
  return label ? label : null;
}

/**
 * Flags two or more targets sharing a `label`, which backlog-adopt matches a GitHub issue's
 * labels against. Two targets with the same label can never resolve to exactly one.
 */
export function checkTargetLabelCollisions(
  file: string,
  targets: readonly ConfigTarget[],
): Report {
  const report = emptyReport();
  const byLabel = new Map<string, string[]>();

  for (const target of targets) {
    const label = normalizedLabel(target);
    if (label === null) continue;
    const names = byLabel.get(label) ?? [];
    names.push(target.name);
    byLabel.set(label, names);
  }

  for (const [label, names] of byLabel) {
    if (names.length < 2) continue;
    report.findings.push({
      rule: 'backlog-adopt/target-label-collision',
      level: 'error',
      file,
      line: null,
      msg: `targets ${names.join(', ')} share the label "${label}". An issue carrying that label cannot resolve to exactly one target.`,
    });
  }

  return report;
}

/**
 * Flags two targets with the IDENTICAL `pathPrefix`, which backlog-adopt matches a repo path
 * named in the issue body against.
 *
 * One prefix nested inside another, `packages/cli/` and `packages/cli/test/fixture/`, is not
 * flagged. A longest-prefix-match resolves that pair to exactly one target, the more specific
 * one, the same way most router and glob matching does. Only an identical pair is genuinely
 * undecidable, since nothing can pick between them. Measured against this repo's own 17
 * targets: the naive "one contains the other" version flagged `cli`/`plugin-fixture`, a
 * legitimate nested pair, as its only finding, a false positive this narrower version avoids.
 */
export function checkTargetPathPrefixOverlap(
  file: string,
  targets: readonly ConfigTarget[],
): Report {
  const report = emptyReport();
  const named = targets.filter(
    (target): target is ConfigTarget & { pathPrefix: string } =>
      target.pathPrefix !== undefined,
  );

  const byPrefix = new Map<string, string[]>();
  for (const target of named) {
    const names = byPrefix.get(target.pathPrefix) ?? [];
    names.push(target.name);
    byPrefix.set(target.pathPrefix, names);
  }

  for (const [pathPrefix, names] of byPrefix) {
    if (names.length < 2) continue;
    report.findings.push({
      rule: 'backlog-adopt/target-path-prefix-overlap',
      level: 'error',
      file,
      line: null,
      msg: `targets ${names.join(', ')} share the identical path prefix "${pathPrefix}". A path named in an issue body cannot resolve to exactly one of them.`,
    });
  }

  return report;
}

function main(): void {
  const root = repoRoot();
  const config = loadConfigSafe();
  const directory = ledgerDir(root, config.ledgers?.dir);
  const backlogFile = ledgerPath(root, 'backlog', config.ledgers?.dir);
  const backlogRelative = relativeToRoot(root, backlogFile);
  const configRelative = 'houserules.config.json';

  const records = readLog<AdoptRecord>(backlogFile);
  const index = loadIndex(directory, 'backlog');

  const report = emptyReport();
  report.declined.push(...DECLINED);
  report.findings.push(
    ...checkDuplicateIssueAdoption(backlogRelative, records).findings,
    ...checkAdoptedTitleDrift(backlogRelative, records, index).findings,
    ...checkTargetLabelCollisions(configRelative, config.targets).findings,
    ...checkTargetPathPrefixOverlap(configRelative, config.targets).findings,
  );

  process.stdout.write(`${renderReport(report)}\n`);
  process.exit(exitCodeFor(report));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
