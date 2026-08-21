#!/usr/bin/env node
/**
 * Checks a rendered `DECISIONS.md` surface against the two structural clauses of the
 * `decide` skill's bar that a script can decide alone.
 *
 * Whether a rejected alternative or a revisit trigger is genuine, rather than invented to
 * pass the check, is judgment the skill keeps. This only checks that the fields exist, and
 * that a path-shaped token in the revisit trigger made it into `--scope`.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { ENTRY_HEAD } from '@houserules/payload/backlog-id';
import { SEPARATOR } from '@houserules/payload/entry-ledger';
import {
  emptyReport,
  exitCodeFor,
  renderReport,
  type Finding,
  type Report,
} from '@houserules/payload/findings';

const DECLINED = [
  'whether a rejected alternative was genuinely considered, or a revisit trigger is genuinely falsifiable, rather than invented to pass this check, a judgment the decide skill keeps',
  'whether a path-shaped token in a revisit trigger genuinely means "someone touches this path", left to a person even when the token is found',
];

// Capital-first-letter and word-boundary anchored, not paragraph-start anchored. A record
// spells its Rejected/Revisit clause as its own leading paragraph most of the time, but not
// always: some fold "Revisit when ..." into a trailing sentence of a longer paragraph. Both
// count as the field being present. A lowercase mid-sentence "revisit" (recounting something
// that already happened, not stating the field) does not match, since the word is capitalized
// only when it opens the clause.
const REJECTED_WORD = /\bRejected\b/;
const REVISIT_WORD = /\bRevisit\b/;
const SCOPE_LINE = /^\*\*Scope:\*\* (.+)$/m;
const PATH_TOKEN = /`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)`/g;
const SUPERSEDED_STATUS = /\*\*Status:\*\* superseded\b/;

interface DecisionRecord {
  id: string;
  line: number;
  text: string;
  scope: string[];
  superseded: boolean;
}

/** One rendered entry's body text and 1-indexed heading line, split on `## [id]` and `---`. */
function splitRecords(markdown: string): DecisionRecord[] {
  const lines = markdown.split('\n');
  const records: DecisionRecord[] = [];
  let currentId: string | null = null;
  let currentLine = 0;
  let bodyLines: string[] = [];

  const flush = (): void => {
    if (currentId === null) return;
    const text = bodyLines.join('\n');
    const scopeMatch = text.match(SCOPE_LINE);
    const scope = scopeMatch
      ? scopeMatch[1]!.split(',').map((s) => s.trim().replace(/^`|`$/g, ''))
      : [];
    records.push({
      id: currentId,
      line: currentLine,
      text,
      scope,
      superseded: SUPERSEDED_STATUS.test(text),
    });
    currentId = null;
    bodyLines = [];
  };

  lines.forEach((line, index) => {
    const head = line.match(ENTRY_HEAD);
    if (head) {
      flush();
      currentId = head[1]!;
      currentLine = index + 1;
      return;
    }
    if (line.trim() === SEPARATOR) {
      flush();
      return;
    }
    if (currentId !== null) bodyLines.push(line);
  });
  flush();

  return records;
}

/** Every paragraph, split on a blank line, that carries `pattern` somewhere in its text. */
function paragraphsMatching(text: string, pattern: RegExp): string[] {
  return text.split(/\n\s*\n/).filter((paragraph) => pattern.test(paragraph));
}

/**
 * The `decide` skill refuses to record a decision missing a Rejected or a Revisit field. This
 * catches the same gap after the fact, in whatever is already rendered.
 *
 * Superseded records are skipped: they are immutable history no action can add fields to,
 * and their supersessor is the record that owes them.
 */
export function checkRequiredFields(file: string, markdown: string): Report {
  const report = emptyReport();
  for (const record of splitRecords(markdown)) {
    if (record.superseded) continue;
    if (paragraphsMatching(record.text, REJECTED_WORD).length === 0) {
      report.findings.push({
        rule: 'decide/required-fields',
        level: 'error',
        file,
        line: record.line,
        msg: `${record.id} has no Rejected field. Ask the user for a genuine rejected alternative rather than inventing one.`,
      });
    }
    if (paragraphsMatching(record.text, REVISIT_WORD).length === 0) {
      report.findings.push({
        rule: 'decide/required-fields',
        level: 'error',
        file,
        line: record.line,
        msg: `${record.id} has no Revisit field. Ask the user for a genuine revisit trigger rather than inventing one.`,
      });
    }
  }
  return report;
}

/**
 * A revisit trigger naming a repo path is path-watchable, and the skill says to add that
 * path to `--scope` too, so `scope <path>` surfaces the record. A path-shaped token inside
 * a paragraph carrying the Revisit clause that is not among the record's scoped paths is a
 * candidate for that gap, not a decided defect: only a person can confirm the trigger
 * genuinely means "someone touches this path".
 */
export function checkPathWatchableScope(
  file: string,
  markdown: string,
): Report {
  const report = emptyReport();
  for (const record of splitRecords(markdown)) {
    if (record.superseded) continue;
    const paragraphs = paragraphsMatching(record.text, REVISIT_WORD);
    if (paragraphs.length === 0) continue;
    const tokens = paragraphs.flatMap((paragraph) =>
      [...paragraph.matchAll(PATH_TOKEN)].map((m) => m[1]!),
    );
    const missing = [...new Set(tokens)].filter(
      (token) => !record.scope.includes(token),
    );
    if (missing.length === 0) continue;
    report.findings.push({
      rule: 'decide/path-watchable-scope',
      level: 'warn',
      file,
      line: record.line,
      msg: `${record.id}'s revisit trigger names ${missing.join(', ')}, not in Scope. If touching that path is genuinely the trigger, add it with rescope so scope <path> surfaces this record.`,
    });
  }
  return report;
}

function checkFile(file: string, markdown: string): Finding[] {
  return [
    ...checkRequiredFields(file, markdown).findings,
    ...checkPathWatchableScope(file, markdown).findings,
  ];
}

function main(): void {
  const files = process.argv.slice(2);
  const report = emptyReport();
  report.declined.push(...DECLINED);
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    report.findings.push(...checkFile(file, text));
  }
  process.stdout.write(`${renderReport(report)}\n`);
  process.exit(exitCodeFor(report));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
