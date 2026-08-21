#!/usr/bin/env node
/**
 * Checks shipped markdown against the mechanical clauses of `prose-voice.md`.
 *
 * Only the clauses a script can decide alone land here. "No semicolons" is one, because a
 * semicolon in prose either is or is not there. The "never more than one em dash per
 * paragraph" sub-clause is another, a count. Whether "where a period or comma works" is not,
 * because the qualifier is the whole clause, so it stays in the rule for a reader to apply.
 *
 * Probe 3b measured a naive version of this checker at zero true positives out of two
 * findings, and both failures were in the segmentation rather than the rule: a semicolon
 * inside a multi-line inline-code span, and a semicolon inside a blockquoted example that a
 * document quotes precisely in order to forbid it. That is why this reads prose through
 * `stripToProse` and never through its own regex.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { stripToProse } from '@houserules/payload/markdown-segment';
import {
  emptyReport,
  exitCodeFor,
  renderReport,
  type Finding,
  type Report,
} from '@houserules/payload/findings';

const DECLINED = [
  'whether a surviving em dash is a genuine, unreplaceable aside, a judgment the rule keeps',
  'filler words, measured unreliable and left to the rule',
  'sentence length and asides, which need a real tokenizer to split on',
];

const EM_DASH = '—';

/**
 * One `warn` finding per em dash, plus an `error` finding on any paragraph carrying two or
 * more. The rule permits one em dash per paragraph, so this counts rather than bans, and a
 * paragraph is a run of non-blank lines separated by a blank one.
 */
function checkEmDashes(file: string, prose: string): Finding[] {
  const findings: Finding[] = [];
  const lines = prose.split('\n');
  let paragraphLines: number[] = [];

  const closeParagraph = (): void => {
    if (paragraphLines.length < 2) {
      paragraphLines = [];
      return;
    }
    findings.push({
      rule: 'prose-voice/em-dash-density',
      level: 'error',
      file,
      line: paragraphLines[0]! + 1,
      msg: `${paragraphLines.length} em dashes in one paragraph (lines ${paragraphLines[0]! + 1}-${paragraphLines[paragraphLines.length - 1]! + 1}). Keep at most one per paragraph.`,
    });
    paragraphLines = [];
  };

  lines.forEach((line, index) => {
    if (line.trim() === '') {
      closeParagraph();
      return;
    }
    const count = line.split(EM_DASH).length - 1;
    for (let i = 0; i < count; i++) {
      findings.push({
        rule: 'prose-voice/em-dash-present',
        level: 'warn',
        file,
        line: index + 1,
        msg: 'Em dash present. Rewrite as a period or comma unless the aside genuinely needs it, and never more than one per paragraph.',
      });
      paragraphLines.push(index);
    }
  });
  closeParagraph();

  return findings;
}

function checkSemicolons(file: string, prose: string): Finding[] {
  const findings: Finding[] = [];
  prose.split('\n').forEach((line, index) => {
    if (!line.includes(';')) return;
    findings.push({
      rule: 'prose-voice/no-semicolons',
      level: 'error',
      file,
      line: index + 1,
      msg: 'Semicolon in prose. Use a period, or a comma with a conjunction.',
    });
  });
  return findings;
}

/** Findings for one file, keyed to the clause rather than to this checker. */
export function checkProse(file: string, markdown: string): Report {
  const report = emptyReport();
  const prose = stripToProse(markdown);
  report.findings.push(...checkSemicolons(file, prose));
  report.findings.push(...checkEmDashes(file, prose));
  return report;
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
    report.findings.push(...checkProse(file, text).findings);
  }
  process.stdout.write(`${renderReport(report)}\n`);
  process.exit(exitCodeFor(report));
}

// Both sides go through `realpathSync` before comparing, matching the pattern the other
// payload scripts use. `process.argv[1]` stays the literal invocation path while
// `import.meta.url` resolves through any symlink in its ancestry, so raw string comparison
// misses on any repo staged under a symlinked temp dir. Guarding this way is also what lets
// a test import `checkProse` without the module exiting the process on load.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
