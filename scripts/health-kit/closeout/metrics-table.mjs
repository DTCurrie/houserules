#!/usr/bin/env node
// Dev-only. Prints a before/after Markdown table from `houserules doctor` and
// `houserules report` captures.
// Usage: node metrics-table.mjs <before-doctor> <after-doctor> [<before-report> <after-report>]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NOT_CAPTURED = 'not captured';

const USAGE =
  'usage: node scripts/health-kit/closeout/metrics-table.mjs <before-doctor> <after-doctor> [<before-report> <after-report>]';

const RESIDENT_PATTERNS = [
  /resident context \(CLAUDE\.md\): ~(\d+) tokens/,
  /resident skill\/agent descriptions[^:\n]*: ~(\d+) tokens/,
  /resident output style[^:\n]*: ~(\d+) tokens/,
];

/** Sum of the three resident lines, or null when any one is missing. */
function parseAlwaysLoaded(doctorText) {
  if (doctorText == null) return null;
  let total = 0;
  for (const pattern of RESIDENT_PATTERNS) {
    const match = pattern.exec(doctorText);
    if (!match) return null;
    total += Number(match[1]);
  }
  return total;
}

function parseLargestSkill(doctorText) {
  if (doctorText == null) return null;
  const match = /largest body (\d+) bytes/.exec(doctorText);
  return match ? Number(match[1]) : null;
}

// The p95ms column's position in a Stop hooks table row: hook, runs, p50ms, p95ms.
const P95_COLUMN_INDEX = 3;

/** The p95ms column of the lint-format-fix.mjs row in the Stop hooks table. */
function parseStopP95(reportText) {
  if (reportText == null) return null;
  for (const line of reportText.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (
      cols[0] === 'lint-format-fix.mjs' &&
      /^\d+$/.test(cols[P95_COLUMN_INDEX] ?? '')
    ) {
      return Number(cols[P95_COLUMN_INDEX]);
    }
  }
  return null;
}

/**
 * Total of the `blocks` column (the last column) across every row of the
 * guard efficacy table. A present section with no rows is 0 blocks.
 */
function parseGuardBlocks(reportText) {
  if (reportText == null) return null;
  const lines = reportText.split('\n');
  const start = lines.findIndex((line) =>
    line.includes('-- guard efficacy --'),
  );
  if (start === -1) return null;
  let lineIndex = start + 1;
  while (lineIndex < lines.length && !/^\s*-{3,}\s/.test(lines[lineIndex])) {
    if (/^\s*--\s/.test(lines[lineIndex])) return 0;
    lineIndex += 1;
  }
  let total = 0;
  for (
    lineIndex += 1;
    lineIndex < lines.length && lines[lineIndex].trim() !== '';
    lineIndex += 1
  ) {
    const lastColumn = lines[lineIndex].trim().split(/\s+/).at(-1);
    if (!/^\d+$/.test(lastColumn)) return null;
    total += Number(lastColumn);
  }
  return total;
}

function cell(value) {
  return value == null ? NOT_CAPTURED : String(value);
}

function delta(before, after) {
  if (before == null || after == null) return NOT_CAPTURED;
  const diff = after - before;
  return diff > 0 ? `+${diff}` : String(diff);
}

function row(label, before, after) {
  return `| ${label} | ${cell(before)} | ${cell(after)} | ${delta(before, after)} |`;
}

/** Each argument is a capture's text, or null when that capture is absent. */
function renderTable({ beforeDoctor, afterDoctor, beforeReport, afterReport }) {
  return [
    '| metric | before | after | delta |',
    '| --- | --- | --- | --- |',
    row(
      'always-loaded total (tokens)',
      parseAlwaysLoaded(beforeDoctor),
      parseAlwaysLoaded(afterDoctor),
    ),
    row(
      'largest skill body (bytes)',
      parseLargestSkill(beforeDoctor),
      parseLargestSkill(afterDoctor),
    ),
    row(
      'lint-format-fix.mjs Stop p95 (ms)',
      parseStopP95(beforeReport),
      parseStopP95(afterReport),
    ),
    row(
      'guard blocks',
      parseGuardBlocks(beforeReport),
      parseGuardBlocks(afterReport),
    ),
  ].join('\n');
}

const DOCTOR_ONLY_ARGS = 2;
const DOCTOR_AND_REPORT_ARGS = 4;

function main(argv) {
  if (
    argv.length !== DOCTOR_ONLY_ARGS &&
    argv.length !== DOCTOR_AND_REPORT_ARGS
  ) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let texts;
  try {
    texts = argv.map((file) => readFileSync(file, 'utf8'));
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  const [beforeDoctor, afterDoctor, beforeReport = null, afterReport = null] =
    texts;
  process.stdout.write(
    `${renderTable({ beforeDoctor, afterDoctor, beforeReport, afterReport })}\n`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
