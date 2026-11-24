#!/usr/bin/env node
/**
 * Scores every `<out>/<arm>/sample-<k>/` of the plan-stop-rule fixture. Free: no network, no
 * session. Prints one table row and one `JSON {...}` line per sample.
 *
 *   node score.mjs <out-dir>
 *
 * Columns: `valid` is the runner's own validity judgment. `beforeWrite` counts the main
 * thread's tool calls before its first write under `.claude/plans/`, or `-` when it never wrote
 * there. A write is a file tool on such a path, a Bash call that runs `plan-scaffold`, or a Bash
 * segment that redirects, tees, creates, copies, or moves into one. `calls` counts every main
 * thread tool call. `wallS` is the result event's `duration_ms` in seconds. `cost` is its
 * `total_cost_usd`, else the ledger line. `roadmap` says whether the collected `tree/` holds a
 * `ROADMAP.md` under `.claude/plans/` outside the seeded `ignored-payload` plan.
 *
 * Exit codes: 0 when every sample was scored, 2 on a usage error.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { judgeArmValidity } from '../../fixture-arm.mjs';
import { loadSample } from '../../orchestrate-report.mjs';

const PLANS_PATH = '.claude/plans/';
const SEEDED_PLAN = 'ignored-payload';
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const WRITING_COMMANDS = new Set(['mkdir', 'touch', 'cp', 'mv', 'tee']);
const SEGMENT_SEPARATOR = /&&|\|\||[;|\n]/;
const REDIRECT_TARGET = />{1,2}\s*([^\s;&|<>()]+)/g;
const SHELL_ASSIGNMENT = /(?:^|[\s;&|])([A-Za-z_]\w*)=([^\s;&|]+)/g;
const SHELL_VARIABLE = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g;
const SURROUNDING_QUOTES = /^['"]|['"]$/g;
const MS_PER_SECOND = 1000;
const COST_DECIMAL_PLACES = 4;
const WALL_DECIMAL_PLACES = 1;
const EXIT_USAGE = 2;

/** Every tool_use block the main thread's assistant events hold, each once, in order. */
function mainToolUses(stream) {
  const seen = new Set();
  const uses = [];
  for (const event of stream) {
    if (event?.type !== 'assistant' || event.parent_tool_use_id != null)
      continue;
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use' || seen.has(block.id)) continue;
      seen.add(block.id);
      uses.push(block);
    }
  }
  return uses;
}

/** True when one shell segment writes a path under `.claude/plans/`. */
function isSegmentWrite(segment) {
  for (const match of segment.matchAll(REDIRECT_TARGET)) {
    if (match[1].includes(PLANS_PATH)) return true;
  }
  const words = segment.trim().split(/\s+/);
  return WRITING_COMMANDS.has(words[0]) && words.at(-1).includes(PLANS_PATH);
}

/**
 * The command with each `$NAME` or `${NAME}` that a `NAME=value` in the same command assigns
 * replaced by its value, so `W=.claude/plans/x; cat > $W/PLAN.md` reads as a plan write.
 */
function expandAssignments(command) {
  const values = new Map();
  for (const [, name, value] of command.matchAll(SHELL_ASSIGNMENT)) {
    values.set(name, value.replace(SURROUNDING_QUOTES, ''));
  }
  return command.replace(
    SHELL_VARIABLE,
    (reference, braced, bare) => values.get(braced ?? bare) ?? reference,
  );
}

/** True when a tool call writes under `.claude/plans/`. */
function isPlanWrite(use) {
  if (FILE_TOOLS.has(use.name)) {
    const path = use.input?.file_path ?? use.input?.notebook_path ?? '';
    return path.includes(PLANS_PATH);
  }
  if (use.name !== 'Bash') return false;
  const command = expandAssignments(String(use.input?.command ?? ''));
  if (command.includes('plan-scaffold')) return true;
  return command.split(SEGMENT_SEPARATOR).some(isSegmentWrite);
}

/** The ledger line for `arm` and `sample` under `out`, or null. */
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

/** True when `tree/.claude/plans/` holds a ROADMAP.md that is not in the seeded plan. */
function hasNewRoadmap(sampleDir) {
  const plans = join(sampleDir, 'tree', '.claude', 'plans');
  if (!existsSync(plans)) return false;
  return readdirSync(plans, { recursive: true, withFileTypes: true }).some(
    (entry) =>
      entry.isFile() &&
      entry.name === 'ROADMAP.md' &&
      !entry.parentPath.split(sep).includes(SEEDED_PLAN),
  );
}

function scoreSample(out, arm, dir) {
  const sampleNumber = Number(/^sample-(\d+)$/.exec(dir.split(sep).at(-1))[1]);
  const sample = loadSample(dir);
  const validity = judgeArmValidity(
    sample,
    sample.run?.validityAgent ?? 'plan-reviewer',
  );
  const uses = mainToolUses(sample.stream);
  const firstWrite = uses.findIndex(isPlanWrite);
  const result = sample.stream
    .filter((event) => event?.type === 'result')
    .at(-1);
  return {
    arm,
    sample: sampleNumber,
    valid: validity.valid,
    validity: validity.line,
    beforeWrite: firstWrite < 0 ? null : firstWrite,
    calls: uses.length,
    wallSeconds:
      typeof result?.duration_ms === 'number'
        ? result.duration_ms / MS_PER_SECOND
        : null,
    cost:
      typeof result?.total_cost_usd === 'number'
        ? result.total_cost_usd
        : ledgerCost(out, arm, sampleNumber),
    roadmap: hasNewRoadmap(dir),
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
    left.localeCompare(right, 'en', { numeric: true }),
  );
}

const orDash = (value, format) => (value === null ? '-' : format(value));

function main(argv) {
  const out = argv[0];
  if (!out || !existsSync(out)) {
    console.error('usage: node score.mjs <out-dir>');
    return EXIT_USAGE;
  }
  console.log(
    [
      'arm',
      'sample',
      'valid',
      'beforeWrite',
      'calls',
      'wallS',
      'cost',
      'roadmap',
    ].join('\t'),
  );
  for (const [arm, dir] of sampleDirs(out)) {
    const row = scoreSample(out, arm, dir);
    console.log(
      [
        row.arm,
        row.sample,
        row.valid,
        orDash(row.beforeWrite, String),
        row.calls,
        orDash(row.wallSeconds, (value) => value.toFixed(WALL_DECIMAL_PLACES)),
        orDash(row.cost, (value) => value.toFixed(COST_DECIMAL_PLACES)),
        row.roadmap,
      ].join('\t'),
    );
    console.log(`JSON ${JSON.stringify(row)}`);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
