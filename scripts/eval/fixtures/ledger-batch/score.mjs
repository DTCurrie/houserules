#!/usr/bin/env node
/**
 * Scores every `<out>/<arm>/sample-<k>/` of the ledger-batch fixture. Free: no network, no
 * session. Prints one row per sample.
 *
 *   node score.mjs <out-dir>
 *
 * Columns: `reviewers` counts the Agent calls naming `backlog-reviewer` or `decision-reviewer`
 * (`backlogReviewers` and `decisionReviewers` split them), `rows` the non-blank lines of the
 * collected `tree/.claude/ledgers/*.jsonl`, `cost` the result event's `total_cost_usd` (the
 * `spend.jsonl` line when the stream has none), and `wall` the seconds from the first to the last
 * timestamp in the transcripts, null with fewer than two. A batched sample holds two reviewers, one per ledger. A per-entry sample holds four.
 *
 * Exit codes: 0 when every sample was scored, 2 on a usage error.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadSample, wallSeconds } from '../../orchestrate-report.mjs';

const BACKLOG_REVIEWER = 'backlog-reviewer';
const DECISION_REVIEWER = 'decision-reviewer';
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const EXIT_USAGE = 2;
const COST_DECIMAL_PLACES = 4;
const WALL_DECIMAL_PLACES = 1;

function toolUses(records) {
  return records.flatMap((record) => {
    const content = record?.message?.content;
    return Array.isArray(content)
      ? content.filter((block) => block?.type === 'tool_use')
      : [];
  });
}

function reviewerCounts(stream) {
  const seen = new Set();
  const counts = { [BACKLOG_REVIEWER]: 0, [DECISION_REVIEWER]: 0 };
  for (const use of toolUses(stream)) {
    if (!AGENT_TOOLS.has(use.name) || seen.has(use.id)) continue;
    seen.add(use.id);
    const type = use.input?.subagent_type;
    if (type in counts) counts[type] += 1;
  }
  return counts;
}

function ledgerRows(dir) {
  const ledgers = join(dir, 'tree', '.claude', 'ledgers');
  if (!existsSync(ledgers)) return 0;
  return readdirSync(ledgers)
    .filter((name) => name.endsWith('.jsonl'))
    .reduce(
      (total, name) =>
        total +
        readFileSync(join(ledgers, name), 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '').length,
      0,
    );
}

function ledgerCost(out, arm, sample) {
  const ledger = join(out, 'spend.jsonl');
  if (!existsSync(ledger)) return null;
  for (const line of readFileSync(ledger, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const entry = JSON.parse(line);
    if (entry.arm === arm && entry.sample === sample) return entry.costUsd;
  }
  return null;
}

function scoreSample(out, arm, dir) {
  const sampleNumber = Number(/sample-(\d+)$/.exec(dir)[1]);
  const sample = loadSample(dir);
  const result = sample.stream
    .filter((event) => event?.type === 'result')
    .at(-1);
  const counts = reviewerCounts(sample.stream);
  return {
    arm,
    sample: sampleNumber,
    reviewers: counts[BACKLOG_REVIEWER] + counts[DECISION_REVIEWER],
    backlogReviewers: counts[BACKLOG_REVIEWER],
    decisionReviewers: counts[DECISION_REVIEWER],
    rows: ledgerRows(dir),
    cost:
      typeof result?.total_cost_usd === 'number'
        ? result.total_cost_usd
        : ledgerCost(out, arm, sampleNumber),
    wall: wallSeconds(sample),
  };
}

function sampleDirs(out) {
  const found = [];
  for (const arm of readdirSync(out, { withFileTypes: true })) {
    if (!arm.isDirectory()) continue;
    for (const entry of readdirSync(join(out, arm.name), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory() && /^sample-\d+$/.test(entry.name))
        found.push([arm.name, join(out, arm.name, entry.name)]);
    }
  }
  return found.sort(([, left], [, right]) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
}

function formatRow(score) {
  const cost =
    score.cost === null ? 'n/a' : `$${score.cost.toFixed(COST_DECIMAL_PLACES)}`;
  const wall =
    score.wall === null ? 'n/a' : `${score.wall.toFixed(WALL_DECIMAL_PLACES)}s`;
  return [
    `${score.arm} sample-${score.sample}`,
    `reviewers=${score.reviewers} (backlog ${score.backlogReviewers}, decision ${score.decisionReviewers})`,
    `rows=${score.rows}`,
    `cost=${cost}`,
    `wall=${wall}`,
  ].join('  ');
}

function main(argv) {
  const out = argv[2];
  if (!out || !existsSync(out)) {
    console.error('usage: node score.mjs <out-dir>');
    return EXIT_USAGE;
  }
  for (const [arm, dir] of sampleDirs(out)) {
    const score = scoreSample(out, arm, dir);
    console.log(formatRow(score));
    console.log(`JSON ${JSON.stringify(score)}`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`)
  process.exitCode = main(process.argv);
