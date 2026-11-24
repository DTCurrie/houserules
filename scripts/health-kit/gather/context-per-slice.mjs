#!/usr/bin/env node
/**
 * Prints main-conversation context growth per dispatched slice, one row per phase.
 *
 * Usage: node context-per-slice.mjs --plan <slug> --plan-dir <dir> [--json <out>] <main.jsonl>...
 *
 * Each positional path is a main transcript. A main assistant turn's context is its
 * `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, counted once per
 * `message.id`. An assistant record with no `usage` is not a turn, and a missing usage field
 * counts as 0.
 *
 * A cycle is one spawn or one resume of a `phase-orchestrator` whose prompt carries
 * `Plan: <slug>` and a `Phase: <n>` line. A resume is a `SendMessage` to a spawned
 * orchestrator's agent id, and it opens a cycle only when none is open for that agent. A cycle's
 * growth is the context of the first assistant turn after its hand-back arrives, a peer record
 * with `origin.handback` from that agent, minus the context of the turn that sent the spawn or
 * the resume. A cycle with no hand-back yet is listed as open and left out of every figure. A
 * cycle whose window holds a compaction record, as `compaction.mjs` defines it, is flagged
 * `compacted`. Its delta spans a context reset, so it is left out of the phase sum, and the phase
 * gets no per-slice figure and no part in the mean or median.
 *
 * Phases run in parallel, so one cycle's window can hold turns caused by another phase. Each
 * cycle reports `overlaps`, the count of other cycles whose window intersects it.
 *
 * Slices per phase are the rows of the `## Slices` table in `<plan-dir>/phase-<n>-*.md` whose
 * `owns` cell is not `none`. Growth per slice is a phase's summed growth divided by its slices.
 * Also printed: the mean and median of that figure over phases, the number of direct
 * `task-worker` dispatches from main, and the largest main context seen with the phases open at
 * that turn, and the first turn over the 300,000 token context gate with its open phases.
 *
 * `--json` also writes `{ "schema": "context-per-slice@1", "phases": [...], "cycles": [...],
 * "directDispatches": n, "max": {...}, "gate": {...} | null }`.
 *
 * Exit codes: 0 printed, 2 bad usage. Reads transcripts and plan files, writes `--json` only.
 * Node builtins only.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCompactionRecord } from './compaction.mjs';

const SCHEMA_VERSION = 'context-per-slice@1';
const EXIT_USAGE = 2;
const CONTEXT_GATE = 300000;
const ORCHESTRATOR_TYPE = 'phase-orchestrator';
const DIRECT_WORKER_TYPE = 'task-worker';
const USAGE =
  'usage: node context-per-slice.mjs --plan <slug> --plan-dir <dir> [--json <out>] <main.jsonl>...';

function usageError(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(EXIT_USAGE);
}

function parseArgs(argv) {
  const options = { plan: null, planDir: null, json: null, mains: [] };
  const flags = { '--plan': 'plan', '--plan-dir': 'planDir', '--json': 'json' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg in flags) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        usageError(`${arg} needs a value`);
      options[flags[arg]] = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      usageError(`unknown flag ${arg}`);
    } else {
      options.mains.push(arg);
    }
  }
  if (!options.plan) usageError('--plan is required');
  if (!options.planDir) usageError('--plan-dir is required');
  if (options.mains.length === 0) usageError('no main transcript given');
  return options;
}

function readRecords(path) {
  const records = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn last line from a live session is skipped.
    }
  }
  return records;
}

function contentBlocks(record) {
  const content = record.message?.content;
  return Array.isArray(content) ? content : [];
}

/** The context size of an assistant record, or null when it has no usage. */
function contextOf(record) {
  const usage = record.message?.usage;
  if (record.type !== 'assistant' || !usage) return null;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/**
 * Counts the slice rows of a phase file: rows of the `## Slices` table whose `owns` cell is not
 * `none`.
 */
function countSlices(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^## Slices\s*$/.test(line));
  if (start === -1) return 0;
  let count = 0;
  let ownsColumn = -1;
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    if (!line.trim().startsWith('|')) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());
    if (ownsColumn === -1) {
      ownsColumn = cells.findIndex((cell) => cell.toLowerCase() === 'owns');
      continue;
    }
    if (cells.every((cell) => /^-+$/.test(cell))) continue;
    if (cells[ownsColumn] !== 'none') count += 1;
  }
  return count;
}

function slicesForPhase(planDir, phase) {
  if (!existsSync(planDir)) return null;
  const file = readdirSync(planDir).find((name) =>
    new RegExp(`^phase-${phase}-.+\\.md$`).test(name),
  );
  return file ? countSlices(readFileSync(join(planDir, file), 'utf8')) : null;
}

/** Mutable walk state shared by the steps of `cyclesOf`. */
function createWalkState(plan) {
  return {
    seenMessages: new Set(),
    spawns: new Map(),
    agents: new Map(),
    openByAgent: new Map(),
    cycles: [],
    planLine: new RegExp(
      `^Plan:\\s*${plan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
      'm',
    ),
    directDispatches: 0,
    max: { context: 0, timestamp: null, openPhases: [] },
    gate: null,
    lastContext: 0,
    awaitingAfter: [],
  };
}

function openCycle(state, agentId, phase, kind, before, index) {
  const cycle = {
    phase,
    kind,
    agentId,
    before,
    after: null,
    growth: null,
    startIndex: index,
    endIndex: null,
    isHandedBack: false,
    isCompacted: false,
    overlaps: 0,
  };
  state.cycles.push(cycle);
  state.openByAgent.set(agentId, cycle);
}

/** Records the context of a new assistant turn and closes the cycles awaiting one. */
function trackTurn(state, record, context, index) {
  const isNewTurn =
    context !== null &&
    !(record.message.id && state.seenMessages.has(record.message.id));
  if (context !== null && record.message.id)
    state.seenMessages.add(record.message.id);
  if (!isNewTurn) return;
  state.lastContext = context;
  for (const cycle of state.awaitingAfter.splice(0)) {
    cycle.after = context;
    cycle.growth = context - cycle.before;
    cycle.endIndex = index;
  }
  const snapshot = () => ({
    context,
    timestamp: record.timestamp ?? null,
    openPhases: [
      ...new Set(
        [...state.openByAgent.values()]
          .filter((cycle) => !cycle.isHandedBack)
          .map((cycle) => cycle.phase),
      ),
    ],
  });
  if (context > state.max.context) state.max = snapshot();
  if (context > CONTEXT_GATE && state.gate === null) state.gate = snapshot();
}

function markCompaction(state) {
  for (const cycle of state.openByAgent.values()) {
    if (!cycle.isHandedBack || state.awaitingAfter.includes(cycle))
      cycle.isCompacted = true;
  }
}

/** Counts direct dispatches, remembers orchestrator spawns, and opens a cycle per resume. */
function openCyclesFromToolUses(state, record, context, index) {
  const before = context ?? state.lastContext;
  for (const block of contentBlocks(record)) {
    if (block.type !== 'tool_use') continue;
    const input = block.input ?? {};
    if (block.name === 'Agent') {
      if (input.subagent_type === DIRECT_WORKER_TYPE)
        state.directDispatches += 1;
      const prompt = String(input.prompt ?? '');
      const phase = prompt.match(/^Phase:\s*(\d+)/m)?.[1];
      if (
        input.subagent_type === ORCHESTRATOR_TYPE &&
        state.planLine.test(prompt) &&
        phase
      )
        state.spawns.set(block.id, { phase, before, index });
    }
    if (block.name === 'SendMessage' && state.agents.has(input.to)) {
      const phase = state.agents.get(input.to);
      const openCycleOfAgent = state.openByAgent.get(input.to);
      if (!openCycleOfAgent || openCycleOfAgent.isHandedBack)
        openCycle(state, input.to, phase, 'resume', before, index);
    }
  }
}

/** Opens a spawn cycle for each tool result that returns a remembered spawn's agent id. */
function openCyclesFromToolResults(state, record) {
  for (const block of contentBlocks(record)) {
    if (block.type !== 'tool_result') continue;
    const spawn = state.spawns.get(block.tool_use_id);
    const agentId = record.toolUseResult?.agentId;
    if (spawn && agentId) {
      state.agents.set(agentId, spawn.phase);
      openCycle(
        state,
        agentId,
        spawn.phase,
        'spawn',
        spawn.before,
        spawn.index,
      );
    }
  }
}

/** Marks the open cycle of the agent that sent a hand-back, awaiting the next turn. */
function matchHandback(state, record) {
  const origin = record.origin;
  const cycle = origin?.handback ? state.openByAgent.get(origin.from) : null;
  if (cycle && !cycle.isHandedBack) {
    cycle.isHandedBack = true;
    state.awaitingAfter.push(cycle);
  }
}

/** Sets each closed cycle's `overlaps` to the count of other closed cycles whose window intersects. */
function countOverlaps(cycles) {
  const closed = cycles.filter((cycle) => cycle.growth !== null);
  for (const cycle of closed) {
    cycle.overlaps = closed.filter(
      (other) =>
        other !== cycle &&
        other.startIndex < cycle.endIndex &&
        cycle.startIndex < other.endIndex,
    ).length;
  }
}

/**
 * Walks one main transcript and returns its cycles, the direct dispatch count, and the largest
 * turn.
 */
function cyclesOf(records, plan) {
  const state = createWalkState(plan);
  records.forEach((record, index) => {
    const context = contextOf(record);
    trackTurn(state, record, context, index);
    if (isCompactionRecord(record)) markCompaction(state);
    if (record.type === 'assistant') {
      openCyclesFromToolUses(state, record, context, index);
    } else if (record.type === 'user') {
      openCyclesFromToolResults(state, record);
      matchHandback(state, record);
    }
  });
  countOverlaps(state.cycles);
  return {
    cycles: state.cycles,
    directDispatches: state.directDispatches,
    max: state.max,
    gate: state.gate,
  };
}

/** The cycle as printed to `--json`, with the schema's `handedBack` and `compacted` keys. */
function toCycleRecord(cycle) {
  const { isHandedBack, isCompacted, ...rest } = cycle;
  return {
    phase: rest.phase,
    kind: rest.kind,
    agentId: rest.agentId,
    before: rest.before,
    after: rest.after,
    growth: rest.growth,
    startIndex: rest.startIndex,
    endIndex: rest.endIndex,
    handedBack: isHandedBack,
    compacted: isCompacted,
    overlaps: rest.overlaps,
  };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(cycles, planDir) {
  const byPhase = new Map();
  for (const cycle of cycles.filter((cycle) => cycle.growth !== null)) {
    const entry = byPhase.get(cycle.phase) ?? {
      phase: Number(cycle.phase),
      cycles: 0,
      growth: 0,
      compacted: false,
    };
    entry.cycles += 1;
    if (cycle.isCompacted) entry.compacted = true;
    else entry.growth += cycle.growth;
    byPhase.set(cycle.phase, entry);
  }
  const phases = [...byPhase.values()]
    .sort((left, right) => left.phase - right.phase)
    .map((entry) => {
      const slices = slicesForPhase(planDir, entry.phase);
      return {
        ...entry,
        slices,
        perSlice:
          slices && !entry.compacted ? Math.round(entry.growth / slices) : null,
      };
    });
  const figures = phases
    .map((phase) => phase.perSlice)
    .filter((value) => value !== null);
  return {
    phases,
    mean: figures.length
      ? Math.round(
          figures.reduce((total, value) => total + value, 0) / figures.length,
        )
      : null,
    median: median(figures),
  };
}

function formatTable(summary, totals) {
  const header = [
    'phase',
    'cycles',
    'growth',
    'slices',
    'per-slice',
    'compacted',
  ];
  const rows = summary.phases.map((phase) => [
    String(phase.phase),
    String(phase.cycles),
    String(phase.growth),
    String(phase.slices ?? '?'),
    String(phase.perSlice ?? '?'),
    phase.compacted ? 'yes' : 'no',
  ]);
  const widths = header.map((name, column) =>
    Math.max(name.length, ...rows.map((row) => row[column].length)),
  );
  const format = (row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]))
      .join('  ')
      .trimEnd();
  return [
    format(header),
    ...rows.map(format),
    `mean per-slice: ${summary.mean ?? 'n/a'}`,
    `median per-slice: ${summary.median ?? 'n/a'}`,
    `phases: ${summary.phases.length}`,
    `slices: ${summary.phases.reduce((total, phase) => total + (phase.slices ?? 0), 0)}`,
    `open cycles left out: ${totals.open}`,
    `direct task-worker dispatches: ${totals.directDispatches}`,
    `max main context: ${totals.max.context} at ${totals.max.timestamp ?? 'n/a'}, phases open: ${totals.max.openPhases.join(',') || 'none'}`,
    totals.gate
      ? `first context over ${CONTEXT_GATE}: ${totals.gate.context} at ${totals.gate.timestamp ?? 'n/a'}, phases open: ${totals.gate.openPhases.join(',') || 'none'}`
      : `first context over ${CONTEXT_GATE}: never`,
  ].join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const cycles = [];
  let directDispatches = 0;
  let max = { context: 0, timestamp: null, openPhases: [] };
  let gate = null;
  for (const path of options.mains) {
    if (!existsSync(path)) {
      console.error(`missing transcript: ${path}`);
      continue;
    }
    const result = cyclesOf(readRecords(path), options.plan);
    cycles.push(...result.cycles);
    directDispatches += result.directDispatches;
    if (result.max.context > max.context) max = result.max;
    gate ??= result.gate;
  }
  const summary = summarize(cycles, options.planDir);
  const open = cycles.filter((cycle) => cycle.growth === null).length;
  console.log(formatTable(summary, { open, directDispatches, max, gate }));
  if (options.json) {
    writeFileSync(
      options.json,
      `${JSON.stringify(
        {
          schema: SCHEMA_VERSION,
          ...summary,
          cycles: cycles
            .filter((cycle) => cycle.growth !== null)
            .map(toCycleRecord),
          directDispatches,
          max,
          gate,
        },
        null,
        2,
      )}\n`,
    );
  }
}

main();
