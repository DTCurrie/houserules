#!/usr/bin/env node
/**
 * Structural checks over a `.claude/plans/<slug>/` workspace, the format `orchestrate` and
 * `plan-project` both read and write.
 *
 * These are questions about a format houserules itself controls, not about the judgment a
 * plan records. A status cell either matches the fixed vocabulary or it does not, and a
 * ROADMAP line either names the same status as the sub-plan it links to or it does not.
 * Whether a slice was actually sliced well, or a status change was the right call, stays
 * with the model reading the plan.
 *
 * Usage: plan-lint.mjs
 *        plan-lint.mjs --gates <milestone-dir> <step>
 *
 * Scans every `.claude/plans/*` workspace and impact-map file in the repo. A directory holding
 * `MILESTONE.md` is a milestone: each subdirectory of it holding `ROADMAP.md` is linted as a
 * plan, and the milestone checks run over the members together. The lint takes
 * no arguments, because the object under check is the whole `.claude/plans/` tree, not a file
 * list a caller would otherwise have to enumerate itself.
 *
 * `--gates <milestone-dir> <step>` is the one other form. It reads `<milestone-dir>/MILESTONE.md`
 * and prints one line per gate blocking the step, as `G<n> · <state> · blocks <step>`, or
 * `no gates block <step>`. It prints and does not judge, so an OPEN gate still exits 0. A
 * missing MILESTONE.md or step argument exits nonzero.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import {
  loadConfigSafe,
  repoRootSafe,
  type HouseConfig,
} from '@houserules/payload/config';
import {
  emptyReport,
  exitCodeFor,
  renderReport,
  type Report,
} from '@houserules/payload/findings';

const STATUS_VOCAB = new Set([
  'TODO',
  'DISPATCHED',
  'IN REVIEW',
  'REVISING',
  'DONE',
  'BLOCKED',
]);

const DECLINED = [
  'the three git-status commands `orchestrate` bundles before reading a report (§5), which are process state, not a property of a file on disk',
  'worker-report shape, since a report is an agent message, not a persisted artifact this checker has anything to read',
  'wave-owns glob overlap between slices, deferred with the candidate itself: judging whether two textually distinct globs are safe to run in parallel needs real glob-intersection, not literal string matching',
  'whether a test pinned by a `## Review Focus` item exists in the tree, which is a phase-close check in `orchestrate`, not a property of the plan file',
  "whether two disjoint `**Domain:**` roots stay disjoint at run time, which is the orchestrator's `owns` check over the files a slice actually touches",
  "whether two milestone step items collide through a shared build graph, which the step's `Close` command catches when it runs alone",
  "whether one milestone step item's acceptance reads another item's output, which the step's `Close` command catches when it runs alone",
];

interface SliceTable {
  header: string[];
  rows: string[][];
  /** The 1-based line of each entry in `rows`. */
  rowLines: number[];
}

/** The header row and the separator row that open every markdown table. */
const TABLE_PREAMBLE_ROWS = 2;

/** Finds the `## Slices` markdown table in a phase sub-plan, if it has one. */
function parseSliceTable(markdown: string): SliceTable | null {
  const start = markdown.indexOf('## Slices');
  if (start === -1) return null;
  const lines: string[] = [];
  const lineNumbers: number[] = [];
  const firstLine = markdown.slice(0, start).split('\n').length;
  const following = markdown.slice(start).split('\n');
  for (const [offset, line] of following.entries()) {
    if (line.trim().startsWith('|')) {
      lines.push(line);
      lineNumbers.push(firstLine + offset);
    } else if (lines.length > 0) break;
  }
  if (lines.length < 2 || lines[0] === undefined) return null;
  const splitRow = (line: string): string[] => {
    const cells = line.split('|').map((cell) => cell.trim());
    while (cells.length > 0 && cells[0] === '') cells.shift();
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    return cells;
  };
  const header = splitRow(lines[0]);
  const rows: string[][] = [];
  const rowLines: number[] = [];
  lines.slice(TABLE_PREAMBLE_ROWS).forEach((line, index) => {
    const cells = splitRow(line);
    if (cells.length < 2) return;
    rows.push(cells);
    rowLines.push(lineNumbers[index + TABLE_PREAMBLE_ROWS] ?? firstLine);
  });
  return { header, rows, rowLines };
}

/**
 * Checks the `## Slices` table's `status` column against the fixed vocabulary
 * `TODO`/`DISPATCHED`/`IN REVIEW`/`REVISING`/`DONE`/`BLOCKED`, extending the ROADMAP's own.
 * A trailing parenthetical, such as `DONE (2 revise)`, is part of the cell and stays out of
 * the comparison.
 */
export function checkSliceStatuses(file: string, markdown: string): Report {
  const report = emptyReport();
  const table = parseSliceTable(markdown);
  if (!table) return report;
  const idIdx = table.header.findIndex((h) => h.toLowerCase() === 'id');
  const statusIdx = table.header.findIndex((h) => h.toLowerCase() === 'status');
  if (statusIdx === -1) return report;
  for (const row of table.rows) {
    const cell = (row[statusIdx] ?? '').trim();
    if (!cell) continue;
    const base = cell.replace(/\s*\(.*\)\s*$/, '').trim();
    if (STATUS_VOCAB.has(base)) continue;
    const id = idIdx === -1 ? null : (row[idIdx] ?? '').trim();
    report.findings.push({
      rule: 'plan-lint/slice-status-vocabulary',
      level: 'error',
      file,
      line: null,
      msg: `slice ${id ?? '?'} status "${cell}" is not one of TODO, DISPATCHED, IN REVIEW, REVISING, DONE, BLOCKED`,
    });
  }
  return report;
}

/**
 * Flags each `## Slices` row whose status is not `DONE` in a sub-plan whose `**Status:**`
 * header reads `DONE`, dated or not. A finished phase with a live row is a stale table, and
 * `BLOCKED` counts, since a finished phase has nothing left to block.
 */
export function checkSliceRowsAfterDone(
  file: string,
  markdown: string,
): Report {
  const report = emptyReport();
  if (!isDoneStatus(parseStatusHeader(markdown))) return report;
  const table = parseSliceTable(markdown);
  if (!table) return report;
  const idIdx = table.header.findIndex((h) => h.toLowerCase() === 'id');
  const statusIdx = table.header.findIndex((h) => h.toLowerCase() === 'status');
  if (statusIdx === -1) return report;
  table.rows.forEach((row, index) => {
    const base = (row[statusIdx] ?? '')
      .trim()
      .replace(/\s*\(.*\)\s*$/, '')
      .trim();
    if (!base || base === 'DONE') return;
    const id = idIdx === -1 ? '?' : (row[idIdx] ?? '').trim();
    report.findings.push({
      rule: 'plan-lint/slice-row-after-done',
      level: 'warn',
      file,
      line: table.rowLines[index] ?? null,
      msg: `slice \`${id}\` is \`${base}\` but the phase is \`DONE\``,
    });
  });
  return report;
}

/**
 * The ROADMAP phase line, shared by `checkRoadmapSync` and `parseRoadmapPhases` so the two
 * read one grammar. Groups: phase number, status cell, sub-plan file, and the optional
 * trailing `After` text. The group takes whatever follows `After:` so a malformed value is
 * seen, not silently read as the chain. `parseRoadmapPhases` decides whether it is `none` or a
 * comma-separated list of phase numbers.
 */
const ROADMAP_PHASE_LINE =
  /\*\*Phase (\d+)[^*]*\*\*\s*·\s*Status:\s*([A-Z][A-Za-z ]*(?:\([^)]*\))?)\s*·\s*\[sub-plan\]\(([^)]+)\)(?:\s*·\s*After:([^·\n]*))?/;

/** A phase's `After` marker: the chain default, no dependency, or an explicit list of phase numbers. */
type PhaseAfter = 'chain' | 'none' | number[];

interface RoadmapPhase {
  number: number;
  status: string;
  subplan: string;
  after: PhaseAfter;
  /** Set only when the `After` segment is neither `none` nor a list of integers. `after` is then `chain`. */
  malformedAfter?: string;
}

/** Sorts an `After` cell into `none`, a list of phase numbers, or a malformed segment. */
function classifyAfterCell(
  afterCell: string | undefined,
): Pick<RoadmapPhase, 'after' | 'malformedAfter'> {
  if (afterCell === undefined) return { after: 'chain' };
  const cell = afterCell.trim();
  if (cell === 'none') return { after: 'none' };
  if (/^\d+(?:\s*,\s*\d+)*$/.test(cell)) {
    return { after: cell.split(',').map((part) => Number(part.trim())) };
  }
  return { after: 'chain', malformedAfter: cell };
}

/**
 * Reads every phase line of a ROADMAP. `status` is the raw cell with its parenthetical, and
 * `after` is `chain` when the line carries no `After` segment, and `malformedAfter` holds the
 * text of an `After` segment that is neither `none` nor a comma-separated list of integers.
 */
export function parseRoadmapPhases(markdown: string): RoadmapPhase[] {
  const lineRe = new RegExp(ROADMAP_PHASE_LINE.source, 'g');
  const phases: RoadmapPhase[] = [];
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(markdown))) {
    phases.push({
      number: Number(match[1]),
      status: (match[2] ?? '').trim(),
      subplan: (match[3] ?? '').trim(),
      ...classifyAfterCell(match[4]),
    });
  }
  return phases;
}

/**
 * Reads the roots of a sub-plan's `**Domain:**` line, or `null` when the header has none.
 * Each root is a backticked path. A trailing `(new)` and trailing slashes are dropped, and a
 * glob character is kept so `checkPhaseSchedule` can name it. A line with no backticked root
 * returns an empty array, which `checkPhaseSchedule` reports.
 */
export function parseDomain(markdown: string): string[] | null {
  const line = markdown.match(/^\*\*Domain:\*\*(.*)$/m);
  if (!line) return null;
  const roots: string[] = [];
  const spanRe = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = spanRe.exec(line[1] ?? ''))) {
    const root = (match[1] ?? '')
      .trim()
      .replace(/\s*\(new\)$/, '')
      .replace(/\/+$/, '');
    if (root) roots.push(root);
  }
  return roots;
}

/**
 * Reads the values of a sub-plan's `**Signals:**` line, such as `['ui', 'wide']`, or an empty
 * array when the header has none. Values are comma-separated, and each is the first word of its
 * item with backticks dropped, so `` `wide` (six packages) `` still reads as `wide`.
 */
export function parseSignals(markdown: string): string[] {
  const line = markdown.match(/^\*\*Signals:\*\*(.*)$/m);
  if (!line) return [];
  return (line[1] ?? '')
    .split(',')
    .map((item) => item.replace(/`/g, '').trim().split(/\s+/)[0] ?? '')
    .filter((signal) => signal !== '');
}

/** The `**Signals:**` values a phase may carry. `none` reads as no signal. */
const KNOWN_SIGNALS = new Set(['wide', 'ui', 'live', 'owner', 'flat']);

/** The `**Signals:**` value for a phase the dispatcher runs in its own context, never beside another phase. */
const FLAT_SIGNAL = 'flat';

/** Warns on each `**Signals:**` value outside `wide`, `ui`, `live`, `owner`, `flat`. */
export function checkSignals(file: string, markdown: string): Report {
  const report = emptyReport();
  for (const signal of parseSignals(markdown)) {
    if (signal === 'none' || KNOWN_SIGNALS.has(signal)) continue;
    report.findings.push({
      rule: 'plan-lint/unknown-signal',
      level: 'warn',
      file,
      line: null,
      msg: `unknown signal \`${signal}\`, use wide, ui, live, owner, flat, or none`,
    });
  }
  return report;
}

/** True when a status cell reads DROPPED, with or without its parenthetical. */
function isDroppedStatus(status: string | null): boolean {
  return status !== null && /^DROPPED\b/.test(status);
}

/**
 * Checks that every ROADMAP phase line names the same status, ignoring any trailing
 * parenthetical, as the `**Status:**` header of the sub-plan it links to. A ROADMAP marked
 * `DONE` while its sub-plan header still reads `TODO` is the exact drift `/orchestrate`'s
 * "update both files in the same pass" rule exists to prevent, and it is otherwise silent
 * until a resuming session trusts the wrong one.
 *
 * `subplanStatuses` maps each linked sub-plan filename to its parsed header status, or
 * `null` when the file is missing or has no status header.
 */
export function checkRoadmapSync(
  roadmapFile: string,
  roadmapMarkdown: string,
  subplanStatuses: Record<string, string | null>,
): Report {
  const report = emptyReport();
  const lineRe = new RegExp(ROADMAP_PHASE_LINE.source, 'g');
  const baseOf = (status: string): string => {
    const m = status.match(/^(TODO|IN PROGRESS|DONE|DROPPED|BLOCKED)\b/);
    return m?.[1] ?? status.trim();
  };
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(roadmapMarkdown))) {
    const roadmapStatus = (match[2] ?? '').trim();
    const subplanFile = (match[3] ?? '').trim();
    const subStatus = subplanStatuses[subplanFile];
    if (subStatus === undefined) continue;
    if (subStatus === null) {
      report.findings.push({
        rule: 'plan-lint/roadmap-subplan-sync',
        level: 'error',
        file: roadmapFile,
        line: null,
        msg: `sub-plan "${subplanFile}" is missing or has no **Status:** header, but ROADMAP.md links it as "${roadmapStatus}"`,
      });
      continue;
    }
    if (baseOf(roadmapStatus) !== baseOf(subStatus)) {
      report.findings.push({
        rule: 'plan-lint/roadmap-subplan-sync',
        level: 'error',
        file: roadmapFile,
        line: null,
        msg: `ROADMAP.md says "${roadmapStatus}" for "${subplanFile}", but its own header says "${subStatus}"`,
      });
    }
  }
  return report;
}

const GLOB_CHARS = /[*?{}[\]]/;

/** The `**Signals:**` value for a phase that reads a running process, so it never runs beside another. */
const LIVE_SIGNAL = 'live';

/** Phase numbers that can reach `start` by following `dependenciesByPhase`, never `start` itself unless it sits on a cycle. */
function ancestorsOf(
  start: number,
  dependenciesByPhase: Map<number, number[]>,
): Set<number> {
  const seen = new Set<number>();
  const stack = [...(dependenciesByPhase.get(start) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    stack.push(...(dependenciesByPhase.get(next) ?? []));
  }
  return seen;
}

/** True when two roots are equal or one is a whole-segment prefix of the other. */
function rootsOverlap(firstRoot: string, secondRoot: string): boolean {
  return (
    firstRoot === secondRoot ||
    firstRoot.startsWith(`${secondRoot}/`) ||
    secondRoot.startsWith(`${firstRoot}/`)
  );
}

/** Reports a `**Domain:**` line with no backticked root, and any root with a glob character. */
function reportInvalidDomainRoots(
  phase: RoadmapPhase,
  roots: string[] | null,
  fail: (msg: string) => void,
): void {
  if (roots?.length === 0) {
    fail(
      `phase ${phase.number} (${phase.subplan}) has a **Domain:** line with no backticked root, name each root in backticks or drop the line`,
    );
  }
  for (const root of roots ?? []) {
    if (!GLOB_CHARS.test(root)) continue;
    fail(
      `phase ${phase.number} Domain root \`${root}\` contains a glob character, name a directory or file path`,
    );
  }
}

/**
 * Checks that the `After` markers on a ROADMAP and the `**Domain:**` roots and `**Signals:**`
 * of its sub-plans describe a schedule that can run. It errors on an `After` naming an unknown
 * phase or its own phase, on a cycle, on a glob character in a root, and on any two phases
 * that neither depends on the other through `After` when either carries the `live` signal,
 * either has no domain, or their roots overlap. A pair is reported once, by the first of those
 * that holds. A phase in a cycle or with a bad `After` is left out of the concurrency pairs,
 * since its ordering is already reported. A workspace with no markers is a total order, so it
 * has no concurrent pair and reports nothing.
 *
 * `subplanDomains` maps each sub-plan filename to its parsed roots, or `null` when the file
 * is missing or has no `**Domain:**` line. An empty array is a `**Domain:**` line with no
 * backticked root, which is an error. `subplanSignals` maps each sub-plan filename to its
 * parsed signals, and a filename missing from it carries none.
 */
export function checkPhaseSchedule(
  roadmapFile: string,
  roadmapMarkdown: string,
  subplanDomains: Record<string, string[] | null>,
  subplanSignals: Record<string, string[]>,
): Report {
  const report = emptyReport();
  const phases = parseRoadmapPhases(roadmapMarkdown);
  const known = new Set(phases.map((phase) => phase.number));
  const fail = (msg: string): void => {
    report.findings.push({
      rule: 'plan-lint/phase-schedule',
      level: 'error',
      file: roadmapFile,
      line: null,
      msg,
    });
  };

  const dependenciesByPhase = new Map<number, number[]>();
  const broken = new Set<number>();
  phases.forEach((phase, index) => {
    const previous = phases[index - 1]?.number;
    const declared =
      phase.after === 'chain'
        ? previous === undefined
          ? []
          : [previous]
        : phase.after === 'none'
          ? []
          : phase.after;
    const valid: number[] = [];
    if (phase.malformedAfter !== undefined) {
      broken.add(phase.number);
      fail(
        `phase ${phase.number} has a malformed After segment \`${phase.malformedAfter}\`, use none or a comma-separated list of phase numbers`,
      );
    }
    for (const target of declared) {
      if (target === phase.number) {
        broken.add(phase.number);
        fail(`phase ${phase.number} names itself in After`);
      } else if (!known.has(target)) {
        broken.add(phase.number);
        fail(
          `phase ${phase.number} names phase ${target} in After, which is not in the ROADMAP`,
        );
      } else valid.push(target);
    }
    dependenciesByPhase.set(phase.number, valid);
  });

  const ancestors = new Map<number, Set<number>>();
  for (const phase of phases) {
    ancestors.set(phase.number, ancestorsOf(phase.number, dependenciesByPhase));
  }
  const inCycle = (number: number): boolean =>
    ancestors.get(number)?.has(number) ?? false;

  const reported = new Set<number>();
  for (const phase of phases) {
    if (!inCycle(phase.number) || reported.has(phase.number)) continue;
    const members = phases
      .map((other) => other.number)
      .filter(
        (number) =>
          number === phase.number ||
          (ancestors.get(phase.number)?.has(number) &&
            ancestors.get(number)?.has(phase.number)),
      );
    members.forEach((number) => reported.add(number));
    fail(`phases ${members.join(', ')} form a cycle through After`);
  }

  const rootsOf = (phase: RoadmapPhase): string[] | null => {
    const roots = subplanDomains[phase.subplan];
    return roots === undefined || roots === null
      ? null
      : roots.map((root) => root.replace(/\/+$/, ''));
  };

  for (const phase of phases) {
    reportInvalidDomainRoots(phase, rootsOf(phase), fail);
  }

  phases.forEach((first, index) => {
    for (const second of phases.slice(index + 1)) {
      if (isDroppedStatus(first.status) || isDroppedStatus(second.status)) {
        continue;
      }
      if (inCycle(first.number) || inCycle(second.number)) continue;
      if (broken.has(first.number) || broken.has(second.number)) continue;
      if (ancestors.get(first.number)?.has(second.number)) continue;
      if (ancestors.get(second.number)?.has(first.number)) continue;
      const live = [first, second]
        .filter((phase) => subplanSignals[phase.subplan]?.includes(LIVE_SIGNAL))
        .map((phase) => phase.number);
      if (live.length > 0) {
        const carrier =
          live.length === 1 ? `phase ${live[0]} carries` : 'both carry';
        fail(
          `phases ${first.number} and ${second.number} can run concurrently, but ${carrier} the live signal`,
        );
        continue;
      }
      const isFlat = [first, second].some((phase) =>
        subplanSignals[phase.subplan]?.includes(FLAT_SIGNAL),
      );
      if (isFlat) continue;
      const firstRoots = rootsOf(first);
      const secondRoots = rootsOf(second);
      const lacking = [
        ...(firstRoots === null ? [first.number] : []),
        ...(secondRoots === null ? [second.number] : []),
      ];
      if (firstRoots === null || secondRoots === null) {
        const missing =
          lacking.length === 1
            ? `phase ${lacking[0]} has no **Domain:** line`
            : 'neither has a **Domain:** line';
        fail(
          `phases ${first.number} and ${second.number} can run concurrently, but ${missing}`,
        );
        continue;
      }
      for (const firstRoot of firstRoots) {
        for (const secondRoot of secondRoots) {
          if (!rootsOverlap(firstRoot, secondRoot)) continue;
          fail(
            `phases ${first.number} and ${second.number} can run concurrently, but their Domain roots overlap: \`${firstRoot}\` (phase ${first.number}) and \`${secondRoot}\` (phase ${second.number})`,
          );
        }
      }
    }
  });
  return report;
}

/** A row of a milestone's `## Members` table. */
export interface MilestoneMember {
  name: string;
  owns: string;
  verify: string;
}

/** A row of a milestone's `## Contracts` table. `version` is null when its cell is not an integer. */
export interface MilestoneContract {
  id: string;
  path: string;
  version: number | null;
  /** A `<member>/<phase-slug>` reference. */
  producer: string;
  /** `<member>/<phase-slug>` references. */
  consumers: string[];
}

/** One `## Gates` bullet, such as ``G1 · OPEN · decision · auth approach · blocks `sign-up` ``. */
export interface MilestoneGate {
  id: string;
  /** `OPEN`, `CLOSED`, or `WAIVED`, with any parenthetical dropped. */
  state: string;
  kind: string;
  subject: string;
  /** The slug of the step the gate blocks. */
  blocks: string;
}

/** One claim on a step's `Uses` line: an item holding a resource. */
export interface MilestoneResourceUse {
  item: string;
  resource: string;
}

/** One `### Step:` section of `MILESTONE.md`. */
export interface MilestoneStep {
  slug: string;
  /** The raw status cell, parenthetical included, such as `DONE (2026-11-19)`. */
  status: string;
  /** `<member>/<phase-slug>` references, or null for a scope line, which has no `Items` line. */
  items: string[] | null;
  seam: string | null;
  close: string | null;
  /** Gate ids from the `Needs` line, empty for `none` or no line. */
  needs: string[];
  uses: MilestoneResourceUse[];
  /** The 1-based line of the `### Step:` heading. */
  line: number;
}

/** A parsed `MILESTONE.md`. */
export interface Milestone {
  /** The `**Status:**` header value, or null when there is none. */
  status: string | null;
  members: MilestoneMember[];
  /** Path roots with trailing slashes dropped. */
  heldPaths: string[];
  contracts: MilestoneContract[];
  /** Declared resource names. */
  resources: string[];
  gates: MilestoneGate[];
  /** In file order, which is execution order. */
  steps: MilestoneStep[];
  /** The bullet lines of `## Log`, oldest first. Empty when the section is missing. */
  log: string[];
}

/** One phase of a member plan, as the milestone checks read it. */
export interface MemberPhase {
  number: number;
  /** The `<slug>` of `phase-N-<slug>.md`. */
  slug: string;
  /** The member ROADMAP's status cell for this phase, parenthetical included. */
  status: string;
  /** Parsed by `parseDomain` from the sub-plan, or null when it has no `**Domain:**` line. */
  domain: string[] | null;
  /** Parsed by `parseSignals` from the sub-plan. */
  signals: string[];
}

/** Each member's phases, keyed by the member name the `## Members` table uses. */
export type MemberPlans = Record<string, MemberPhase[]>;

/** Splits a markdown table row into trimmed cells, dropping the outer pipes. */
function splitTableRow(line: string): string[] {
  const cells = line.split('|').map((cell) => cell.trim());
  if (cells[0] === '') cells.shift();
  if (cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/** The data rows of the table in `lines`, past its header and separator rows. */
function tableRows(lines: string[]): string[][] {
  return lines
    .filter((line) => line.trim().startsWith('|'))
    .slice(TABLE_PREAMBLE_ROWS)
    .map(splitTableRow);
}

const unwrapBackticks = (value: string): string =>
  value.replace(/^`([^`]*)`$/, '$1').trim();

const backtickedTokens = (value: string): string[] =>
  [...value.matchAll(/`([^`]+)`/g)].map((match) => (match[1] ?? '').trim());

/** The bullet text of each `- ` line in `lines`. */
function bulletsOf(lines: string[]): string[] {
  return lines
    .map((line) => line.match(/^\s*-\s+(.*)$/)?.[1]?.trim())
    .filter((text): text is string => text !== undefined && text !== '');
}

function parseGate(bullet: string): MilestoneGate {
  const [id = '', stateCell = '', kind = '', subject = '', blocksCell = ''] =
    bullet.split('·').map((part) => part.trim());
  return {
    id,
    state: stateCell.match(/^[A-Z]+/)?.[0] ?? stateCell,
    kind,
    subject,
    blocks: unwrapBackticks(blocksCell.replace(/^blocks\s+/, '')),
  };
}

const STEP_FIELD_NAMES = ['Items', 'Seam', 'Close', 'Needs', 'Uses'] as const;

/** The step field a `- <Name>: ...` line opens, or undefined when the line opens none. */
function stepFieldName(line: string): string | undefined {
  return STEP_FIELD_NAMES.find((name) =>
    new RegExp(`^-\\s+${name}:`).test(line),
  );
}

/** Reads the `Items`/`Seam`/`Close`/`Needs`/`Uses` lines of one step, joining indented continuations. */
function stepFields(lines: string[]): Map<string, string> {
  const fields = new Map<string, string>();
  let current: string | null = null;
  for (const line of lines) {
    const name = stepFieldName(line);
    if (name !== undefined) {
      current = name;
      fields.set(name, line.slice(line.indexOf(':') + 1).trim());
    } else if (current !== null && /^\s+\S/.test(line)) {
      fields.set(current, `${fields.get(current) ?? ''} ${line.trim()}`);
    } else current = null;
  }
  return fields;
}

function parseStep(
  slug: string,
  status: string,
  line: number,
  body: string[],
): MilestoneStep {
  const fields = stepFields(body);
  const items = fields.get('Items');
  const needs = fields.get('Needs');
  const close = fields.get('Close');
  return {
    slug,
    status,
    items: items === undefined ? null : backtickedTokens(items),
    seam: fields.get('Seam') ?? null,
    close: close === undefined ? null : unwrapBackticks(close),
    needs:
      needs === undefined
        ? []
        : needs
            .split(',')
            .map((id) => unwrapBackticks(id.trim()))
            .filter((id) => id !== '' && id !== 'none'),
    uses: [
      ...(fields.get('Uses') ?? '').matchAll(/`([^`]+)`\s+holds\s+`([^`]+)`/g),
    ].map((match) => ({
      item: (match[1] ?? '').trim(),
      resource: (match[2] ?? '').trim(),
    })),
    line,
  };
}

/** One `### Step:` section before its fields are read: the heading's parts and the lines below it. */
interface StepSection {
  slug: string;
  status: string;
  line: number;
  body: string[];
}

/** A `MILESTONE.md` split into the lines of each `## ` section and the sections of each step. */
interface MilestoneSections {
  sections: Map<string, string[]>;
  steps: StepSection[];
}

const STEP_HEADING = /^### Step:\s*(.+?)\s*·\s*Status:\s*(.+?)\s*$/;

/**
 * Splits a `MILESTONE.md` into the lines under each `## ` heading and, under `## Steps`, one
 * `StepSection` per `### Step:` heading. A `###` heading that is not a step ends the step above it.
 */
function scanMilestoneSections(markdown: string): MilestoneSections {
  const sections = new Map<string, string[]>();
  const steps: StepSection[] = [];
  let section: string | null = null;
  let step: StepSection | null = null;
  markdown.split('\n').forEach((line, index) => {
    if (/^## \S/.test(line)) {
      step = null;
      section = line.slice('## '.length).trim();
      sections.set(section, []);
      return;
    }
    if (section !== 'Steps') {
      if (section !== null) sections.get(section)?.push(line);
      return;
    }
    const heading = line.match(STEP_HEADING);
    if (heading) {
      step = {
        slug: (heading[1] ?? '').trim(),
        status: heading[2] ?? '',
        line: index + 1,
        body: [],
      };
      steps.push(step);
    } else if (/^###\s/.test(line)) step = null;
    else step?.body.push(line);
  });
  return { sections, steps };
}

/**
 * Parses a `MILESTONE.md`. A missing section reads as an empty list and nothing throws, so the
 * milestone checks report what is absent instead of this parser failing on it.
 */
export function parseMilestone(markdown: string): Milestone {
  const { sections, steps } = scanMilestoneSections(markdown);
  const lines = (name: string): string[] => sections.get(name) ?? [];
  return {
    status: parseStatusHeader(markdown),
    members: tableRows(lines('Members')).map((cells) => ({
      name: unwrapBackticks(cells[0] ?? ''),
      owns: cells[1] ?? '',
      verify: unwrapBackticks(cells[2] ?? ''),
    })),
    heldPaths: bulletsOf(lines('Held paths'))
      .flatMap((bullet) => backtickedTokens(bullet))
      .map((path) => path.replace(/\/+$/, '')),
    contracts: tableRows(lines('Contracts')).map((cells) => ({
      id: cells[0] ?? '',
      path: unwrapBackticks(cells[1] ?? ''),
      version: /^\d+$/.test(cells[2] ?? '') ? Number(cells[2]) : null,
      producer: unwrapBackticks(cells[3] ?? ''),
      consumers: backtickedTokens(cells[4] ?? ''),
    })),
    resources: bulletsOf(lines('Resources'))
      .map((bullet) => bullet.match(/^`([^`]+)`\s*:/)?.[1]?.trim())
      .filter((name): name is string => name !== undefined),
    gates: bulletsOf(lines('Gates')).map(parseGate),
    steps: steps.map((step) =>
      parseStep(step.slug, step.status, step.line, step.body),
    ),
    log: bulletsOf(lines('Log')),
  };
}

/** The `**Signals:**` value for a phase that needs the owner's input once it starts, at most one per step. */
const OWNER_SIGNAL = 'owner';

/** A status cell with any trailing parenthetical dropped, so `DONE (2026-11-19)` reads `DONE`. */
function statusBase(cell: string): string {
  return cell.replace(/\s*\(.*\)\s*$/, '').trim();
}

/** A `<member>/<phase-slug>` reference read against the `## Members` table and each member's phases. */
type ItemResolution =
  | { kind: 'phase'; key: string; phase: MemberPhase }
  | { kind: 'malformed' }
  | { kind: 'unknown-member'; member: string }
  | { kind: 'unknown-phase'; member: string; slug: string };

/**
 * Resolves a `<member>/<phase-slug>` reference. The member must be a row of the `## Members`
 * table and the slug one of that member's phases, so one slug under two members is two phases.
 * `key` is the `<member>/<phase-slug>` identity the checks compare phases by.
 */
function resolveItem(
  reference: string,
  milestone: Milestone,
  members: MemberPlans,
): ItemResolution {
  const separator = reference.indexOf('/');
  if (separator <= 0 || separator === reference.length - 1) {
    return { kind: 'malformed' };
  }
  const member = reference.slice(0, separator);
  const slug = reference.slice(separator + 1);
  if (!milestone.members.some((row) => row.name === member)) {
    return { kind: 'unknown-member', member };
  }
  const phase = (members[member] ?? []).find(
    (candidate) => candidate.slug === slug,
  );
  if (phase === undefined) return { kind: 'unknown-phase', member, slug };
  return { kind: 'phase', key: `${member}/${slug}`, phase };
}

/** Why a reference did not resolve, as the tail of a finding message. */
function unresolvedReason(
  reference: string,
  resolution: Exclude<ItemResolution, { kind: 'phase' }>,
): string {
  switch (resolution.kind) {
    case 'malformed':
      return `\`${reference}\` is not a \`<member>/<phase-slug>\` reference`;
    case 'unknown-member':
      return `\`${reference}\` names member \`${resolution.member}\`, which is not in the ## Members table`;
    case 'unknown-phase':
      return `\`${reference}\` names phase \`${resolution.slug}\`, which member \`${resolution.member}\` does not have`;
    default: {
      const unhandled: never = resolution;
      return unhandled;
    }
  }
}

/** A step item that resolved to a member phase. */
interface ResolvedItem {
  key: string;
  phase: MemberPhase;
}

/** The items of `step` that resolve to a member phase, in file order. Unresolved items are check 1's. */
function resolvedItems(
  step: MilestoneStep,
  milestone: Milestone,
  members: MemberPlans,
): ResolvedItem[] {
  return (step.items ?? []).flatMap((reference) => {
    const resolution = resolveItem(reference, milestone, members);
    return resolution.kind === 'phase'
      ? [{ key: resolution.key, phase: resolution.phase }]
      : [];
  });
}

/** An error-level finding on `MILESTONE.md`. */
function milestoneError(
  rule: string,
  file: string,
  line: number | null,
  msg: string,
): Report['findings'][number] {
  return { rule, level: 'error', file, line, msg };
}

/** Errors on a step item that names a member not in the `## Members` table, or a phase that member lacks. */
export function checkMilestoneUnknownItems(
  file: string,
  milestone: Milestone,
  members: MemberPlans,
): Report {
  const report = emptyReport();
  for (const step of milestone.steps) {
    for (const reference of step.items ?? []) {
      const resolution = resolveItem(reference, milestone, members);
      if (resolution.kind === 'phase') continue;
      report.findings.push(
        milestoneError(
          'milestone/unknown-item',
          file,
          step.line,
          `step \`${step.slug}\` item ${unresolvedReason(reference, resolution)}`,
        ),
      );
    }
  }
  return report;
}

/** Errors once per member per phase slug that more than one of that member's phases carries. */
export function checkMilestoneDuplicatePhaseSlugs(
  file: string,
  _milestone: Milestone,
  members: MemberPlans,
): Report {
  const report = emptyReport();
  for (const [member, phases] of Object.entries(members)) {
    const numbersBySlug = new Map<string, number[]>();
    for (const phase of phases) {
      numbersBySlug.set(phase.slug, [
        ...(numbersBySlug.get(phase.slug) ?? []),
        phase.number,
      ]);
    }
    for (const [slug, numbers] of numbersBySlug) {
      if (numbers.length < 2) continue;
      report.findings.push(
        milestoneError(
          'milestone/duplicate-phase-slug',
          file,
          null,
          `member \`${member}\` has phase slug \`${slug}\` on phases ${numbers.join(', ')}, so \`${member}/${slug}\` names more than one phase`,
        ),
      );
    }
  }
  return report;
}

/** Errors on each step after the first that holds a member phase an earlier step already holds. */
export function checkMilestonePhaseInTwoSteps(
  file: string,
  milestone: Milestone,
  members: MemberPlans,
): Report {
  const report = emptyReport();
  const firstStepOf = new Map<string, { index: number; slug: string }>();
  milestone.steps.forEach((step, index) => {
    for (const item of resolvedItems(step, milestone, members)) {
      const first = firstStepOf.get(item.key);
      if (first === undefined) {
        firstStepOf.set(item.key, { index, slug: step.slug });
        continue;
      }
      if (first.index === index) continue;
      report.findings.push(
        milestoneError(
          'milestone/phase-in-two-steps',
          file,
          step.line,
          `\`${item.key}\` is an item of step \`${first.slug}\` and of step \`${step.slug}\``,
        ),
      );
    }
  });
  return report;
}

/** Errors on each item of a `DONE` step whose phase is neither `DONE` nor `DROPPED`. */
export function checkMilestoneStepDoneEarly(
  file: string,
  milestone: Milestone,
  members: MemberPlans,
): Report {
  const report = emptyReport();
  for (const step of milestone.steps) {
    if (statusBase(step.status) !== 'DONE') continue;
    for (const item of resolvedItems(step, milestone, members)) {
      if (isClosedPhaseStatus(item.phase.status)) continue;
      report.findings.push(
        milestoneError(
          'milestone/step-done-early',
          file,
          step.line,
          `step \`${step.slug}\` is DONE, but its item \`${item.key}\` is \`${item.phase.status}\``,
        ),
      );
    }
  }
  return report;
}

/** Errors on each item of a `TODO` step whose phase is already `IN PROGRESS` or `DONE`. */
export function checkMilestoneStepTodoLate(
  file: string,
  milestone: Milestone,
  members: MemberPlans,
): Report {
  const report = emptyReport();
  for (const step of milestone.steps) {
    if (statusBase(step.status) !== 'TODO') continue;
    for (const item of resolvedItems(step, milestone, members)) {
      const phaseStatus = statusBase(item.phase.status);
      if (phaseStatus !== 'IN PROGRESS' && phaseStatus !== 'DONE') continue;
      report.findings.push(
        milestoneError(
          'milestone/step-todo-late',
          file,
          step.line,
          `step \`${step.slug}\` is TODO, but its item \`${item.key}\` is \`${item.phase.status}\``,
        ),
      );
    }
  }
  return report;
}

/** Errors once, on the second open step, when more than one step is `IN PROGRESS`. */
export function checkMilestoneOneOpenStep(
  file: string,
  milestone: Milestone,
  _members: MemberPlans,
): Report {
  const report = emptyReport();
  const open = milestone.steps.filter(
    (step) => statusBase(step.status) === 'IN PROGRESS',
  );
  const second = open[1];
  if (second === undefined) return report;
  report.findings.push(
    milestoneError(
      'milestone/one-open-step',
      file,
      second.line,
      `${open.length} steps are IN PROGRESS (${open.map((step) => `\`${step.slug}\``).join(', ')}), and only one may be`,
    ),
  );
  return report;
}

/** Errors on an `IN PROGRESS` or `DONE` step that an `OPEN` gate blocks. `CLOSED` and `WAIVED` pass. */
export function checkMilestoneOpenGates(
  file: string,
  milestone: Milestone,
  _members: MemberPlans,
): Report {
  const report = emptyReport();
  for (const step of milestone.steps) {
    const base = statusBase(step.status);
    if (base !== 'IN PROGRESS' && base !== 'DONE') continue;
    for (const gate of milestone.gates) {
      if (gate.blocks !== step.slug || gate.state !== 'OPEN') continue;
      report.findings.push(
        milestoneError(
          'milestone/open-gate',
          file,
          step.line,
          `step \`${step.slug}\` is ${base}, but gate ${gate.id} blocking it is OPEN`,
        ),
      );
    }
  }
  return report;
}

/**
 * Errors on a step whose `Needs` line disagrees with the gates that block it, in both directions:
 * an id that names no gate or a gate blocking another step, and a blocking gate the line omits.
 * A scope-line step has no `Items` line and yields nothing.
 */
export function checkMilestoneNeedsMatchBlocks(
  file: string,
  milestone: Milestone,
  _members: MemberPlans,
): Report {
  const report = emptyReport();
  const problem = (step: MilestoneStep, message: string): void => {
    report.findings.push(
      milestoneError('milestone/needs-blocks', file, step.line, message),
    );
  };
  for (const step of milestone.steps) {
    if (step.items === null) continue;
    for (const id of step.needs) {
      const gate = milestone.gates.find((candidate) => candidate.id === id);
      if (gate === undefined) {
        problem(
          step,
          `step \`${step.slug}\` needs ${id}, but no gate has that id`,
        );
      } else if (gate.blocks !== step.slug) {
        problem(
          step,
          `step \`${step.slug}\` needs ${id}, but gate ${id} blocks \`${gate.blocks}\``,
        );
      }
    }
    for (const gate of milestone.gates) {
      if (gate.blocks !== step.slug || step.needs.includes(gate.id)) continue;
      problem(
        step,
        `gate ${gate.id} blocks step \`${step.slug}\`, but its Needs line omits ${gate.id}`,
      );
    }
  }
  return report;
}

const BAR_PLACEHOLDER = '<the verdict sentence>';

/**
 * Errors when the first `## Log` bullet has no `Bar:` clause with a real verdict. The empty text
 * and the template placeholder both count as missing. A `DONE` milestone is exempt.
 */
export function checkMilestoneBarRecorded(
  file: string,
  milestone: Milestone,
  _members: MemberPlans,
): Report {
  const report = emptyReport();
  if (isDoneStatus(milestone.status)) return report;
  const verdict = (milestone.log[0] ?? '')
    .match(/\bBar:\s*(.*)$/)?.[1]
    ?.replace(/\.\s*$/, '')
    .trim();
  if (verdict !== undefined && verdict !== '' && verdict !== BAR_PLACEHOLDER) {
    return report;
  }
  report.findings.push(
    milestoneError(
      'milestone/bar-unrecorded',
      file,
      null,
      'the first ## Log line has no `Bar:` clause recording the verdict',
    ),
  );
  return report;
}

/** Each overlapping pair of roots between two root lists, as `[first, second]`. */
function overlappingRoots(
  firstRoots: string[],
  secondRoots: string[],
): Array<[string, string]> {
  return firstRoots.flatMap((firstRoot) =>
    secondRoots
      .filter((secondRoot) => rootsOverlap(firstRoot, secondRoot))
      .map((secondRoot): [string, string] => [firstRoot, secondRoot]),
  );
}

/** One message per overlapping root pair of two items in a step, none when either has no `Domain`. */
function itemPairDomainProblems(
  first: ResolvedItem,
  second: ResolvedItem,
): string[] {
  if (first.phase.domain === null || second.phase.domain === null) return [];
  return overlappingRoots(first.phase.domain, second.phase.domain).map(
    ([firstRoot, secondRoot]) =>
      `items \`${first.key}\` and \`${second.key}\` share a step, but their Domain roots overlap: \`${firstRoot}\` and \`${secondRoot}\``,
  );
}

/**
 * Errors on two items of one step whose `Domain` roots overlap, on an item with no `Domain` line
 * in a step that holds another item, and on any item `Domain` root with a glob character.
 */
export function checkMilestoneItemDomains(
  file: string,
  milestone: Milestone,
  members: MemberPlans,
): Report {
  const report = emptyReport();
  const fail = (line: number, msg: string): void => {
    report.findings.push(
      milestoneError('milestone/item-domain-overlap', file, line, msg),
    );
  };
  for (const step of milestone.steps) {
    const items = resolvedItems(step, milestone, members);
    const holdsOthers = (step.items ?? []).length > 1;
    for (const item of items) {
      for (const root of item.phase.domain ?? []) {
        if (!GLOB_CHARS.test(root)) continue;
        fail(
          step.line,
          `item \`${item.key}\` Domain root \`${root}\` contains a glob character, name a directory or file path`,
        );
      }
      if (holdsOthers && item.phase.domain === null) {
        fail(
          step.line,
          `item \`${item.key}\` has no **Domain:** line, but step \`${step.slug}\` holds other items`,
        );
      }
    }
    items.forEach((first, index) => {
      for (const second of items.slice(index + 1)) {
        if (first.key === second.key) continue;
        itemPairDomainProblems(first, second).forEach((msg) =>
          fail(step.line, msg),
        );
      }
    });
  }
  return report;
}

/** Paths every milestone holds without listing them: the changeset dir and the ledgers. */
const ALWAYS_HELD_PATHS = ['.changeset', '.claude/ledgers'];

/**
 * Errors on a member phase whose `Domain` overlaps a held path, parent or child, and on a held
 * path with a glob character. `.changeset` and `.claude/ledgers` count as held in every milestone.
 * A `DONE` or `DROPPED` phase is skipped, as path checks skip a closed one.
 */
export function checkMilestoneHeldPathOverlap(
  file: string,
  milestone: Milestone,
  members: MemberPlans,
): Report {
  const report = emptyReport();
  const heldPaths = [
    ...new Set([...milestone.heldPaths, ...ALWAYS_HELD_PATHS]),
  ];
  for (const heldPath of milestone.heldPaths) {
    if (!GLOB_CHARS.test(heldPath)) continue;
    report.findings.push(
      milestoneError(
        'milestone/held-path-overlap',
        file,
        null,
        `held path \`${heldPath}\` contains a glob character, name a directory or file path`,
      ),
    );
  }
  for (const [member, phases] of Object.entries(members)) {
    for (const phase of phases) {
      if (isClosedPhaseStatus(phase.status)) continue;
      const overlaps = overlappingRoots(phase.domain ?? [], heldPaths);
      for (const [root, heldPath] of overlaps) {
        report.findings.push(
          milestoneError(
            'milestone/held-path-overlap',
            file,
            null,
            `\`${member}/${phase.slug}\` Domain root \`${root}\` overlaps held path \`${heldPath}\`, which only the milestone session writes`,
          ),
        );
      }
    }
  }
  return report;
}

/** Errors on an item carrying the `live` signal in a step that holds another item. */
export function checkMilestoneLiveItems(
  file: string,
  milestone: Milestone,
  members: MemberPlans,
): Report {
  const report = emptyReport();
  for (const step of milestone.steps) {
    if ((step.items ?? []).length < 2) continue;
    for (const item of resolvedItems(step, milestone, members)) {
      if (!item.phase.signals.includes(LIVE_SIGNAL)) continue;
      report.findings.push(
        milestoneError(
          'milestone/live-item-shared',
          file,
          step.line,
          `item \`${item.key}\` carries the live signal, but step \`${step.slug}\` holds other items`,
        ),
      );
    }
  }
  return report;
}

/** Errors on a `Uses` line naming a resource `## Resources` does not declare, and on two items of one step holding one resource. */
export function checkMilestoneResources(
  file: string,
  milestone: Milestone,
  _members: MemberPlans,
): Report {
  const report = emptyReport();
  for (const step of milestone.steps) {
    const holders = new Map<string, Set<string>>();
    for (const use of step.uses) {
      holders.set(
        use.resource,
        (holders.get(use.resource) ?? new Set<string>()).add(use.item),
      );
      if (milestone.resources.includes(use.resource)) continue;
      report.findings.push(
        milestoneError(
          'milestone/resource-conflict',
          file,
          step.line,
          `step \`${step.slug}\` Uses names resource \`${use.resource}\`, which ## Resources does not declare`,
        ),
      );
    }
    for (const [resource, items] of holders) {
      if (items.size < 2) continue;
      report.findings.push(
        milestoneError(
          'milestone/resource-conflict',
          file,
          step.line,
          `items ${[...items].map((item) => `\`${item}\``).join(', ')} all hold resource \`${resource}\` in step \`${step.slug}\``,
        ),
      );
    }
  }
  return report;
}

/** Errors on a step holding more than one item that carries the `owner` signal. */
export function checkMilestoneOwnerItems(
  file: string,
  milestone: Milestone,
  members: MemberPlans,
): Report {
  const report = emptyReport();
  for (const step of milestone.steps) {
    const owners = resolvedItems(step, milestone, members).filter((item) =>
      item.phase.signals.includes(OWNER_SIGNAL),
    );
    if (owners.length < 2) continue;
    report.findings.push(
      milestoneError(
        'milestone/owner-items-shared',
        file,
        step.line,
        `step \`${step.slug}\` holds ${owners.length} items with the owner signal (${owners.map((item) => `\`${item.key}\``).join(', ')}), and at most one may run flat`,
      ),
    );
  }
  return report;
}

/** Errors on a contract producer or consumer that does not resolve to a member phase. */
export function checkMilestoneContracts(
  file: string,
  milestone: Milestone,
  members: MemberPlans,
): Report {
  const report = emptyReport();
  for (const contract of milestone.contracts) {
    const roles = [
      { role: 'producer', reference: contract.producer },
      ...contract.consumers.map((reference) => ({
        role: 'consumer',
        reference,
      })),
    ];
    for (const { role, reference } of roles) {
      const resolution = resolveItem(reference, milestone, members);
      if (resolution.kind === 'phase') continue;
      report.findings.push(
        milestoneError(
          'milestone/contract-unresolved',
          file,
          null,
          `contract ${contract.id} ${role} ${unresolvedReason(reference, resolution)}`,
        ),
      );
    }
  }
  return report;
}

/**
 * Reports each phase of a `## Members` member that is neither `DONE` nor `DROPPED` and is an item
 * of no step, once every step has its `Items`. While the schedule is still being written, which is
 * a milestone with no steps or with a scope line that has no `Items`, it reports nothing, because
 * the rolling horizon gives a later member phase its ROADMAP line before its step exists.
 */
export function checkMilestoneUnscheduledPhases(
  file: string,
  milestone: Milestone,
  members: MemberPlans,
): Report {
  const report = emptyReport();
  const isScheduleOpen =
    milestone.steps.length === 0 ||
    milestone.steps.some((step) => step.items === null);
  if (isScheduleOpen) return report;
  const scheduled = new Set(
    milestone.steps.flatMap((step) =>
      resolvedItems(step, milestone, members).map((item) => item.key),
    ),
  );
  for (const { name } of milestone.members) {
    for (const phase of members[name] ?? []) {
      const key = `${name}/${phase.slug}`;
      if (isClosedPhaseStatus(phase.status) || scheduled.has(key)) continue;
      report.findings.push({
        rule: 'milestone/unscheduled-phase',
        level: 'error',
        file,
        line: null,
        msg: `\`${key}\` is \`${phase.status}\` and in no step, and every step already has its Items`,
      });
    }
  }
  return report;
}

/**
 * Checks `fix.onSubagentStop` in `houserules.config.json`. `/orchestrate` §4 requires this be
 * unset or false, because a fixer that runs at every worker's exit rewrites files a sibling
 * worker still has open.
 */
export function checkFixOnSubagentStop(config: HouseConfig): Report {
  const report = emptyReport();
  if (config.fix?.onSubagentStop === true) {
    report.findings.push({
      rule: 'plan-lint/fix-on-subagent-stop',
      level: 'error',
      file: '.claude/houserules.config.json',
      line: null,
      msg: "fix.onSubagentStop is true, so the fixer will run at every worker's exit and collide with a sibling slice mid-edit",
    });
  }
  return report;
}

const BLAST_RADIUS_SECTIONS = [
  '## Surface',
  '## Impact by file',
  '## Cross-package / boundary impact',
  '## Completeness self-audit',
];

/**
 * Checks a `blast-radius-<slug>-<date>.md` impact map for the sections and staleness
 * disclaimer `blast-radius/SKILL.md` §3 requires. A map that silently drops
 * `## Completeness self-audit` reads as a full survey to anyone who later trusts it.
 */
export function checkBlastRadiusShape(file: string, markdown: string): Report {
  const report = emptyReport();
  const missingSections = BLAST_RADIUS_SECTIONS.filter(
    (section) => !markdown.includes(section),
  );
  for (const section of missingSections) {
    report.findings.push({
      rule: 'plan-lint/blast-radius-shape',
      level: 'error',
      file,
      line: null,
      msg: `missing required section "${section}"`,
    });
  }
  if (!/snapshot at commit/i.test(markdown)) {
    report.findings.push({
      rule: 'plan-lint/blast-radius-shape',
      level: 'error',
      file,
      line: null,
      msg: 'missing the staleness disclaimer ("Snapshot at commit ...")',
    });
  }
  return report;
}

const IMPACT_MAP_FILE = /^blast-radius-.*\.md$/;

/**
 * Lists the path of every impact map under `plansDir`. `blast-radius/SKILL.md` §3 writes a
 * map into the workspace of the plan it served, and to the root only when no plan was in
 * play, so both homes are read. `workspaceDirs` is every directory directly under `plansDir`,
 * plus each milestone member as `<milestone>/<member>`.
 */
export function listImpactMaps(
  plansDir: string,
  workspaceDirs: string[],
): string[] {
  const homes = [
    plansDir,
    ...workspaceDirs.map((slug) => join(plansDir, slug)),
  ];
  return homes.flatMap((home) =>
    listEntries(home)
      .filter((name) => IMPACT_MAP_FILE.test(name))
      .map((name) => join(home, name)),
  );
}

/**
 * Flags the case `orchestrate/SKILL.md` §0 names as its own precondition: no plan workspace
 * to slice. `planWorkspaceDirs` is every directory found directly under `.claude/plans/`, plus
 * each milestone member.
 */
export function checkNoPlanWorkspace(planWorkspaceDirs: string[]): Report {
  const report = emptyReport();
  if (planWorkspaceDirs.length === 0) {
    report.findings.push({
      rule: 'plan-lint/no-plan-workspace',
      level: 'warn',
      file: '.claude/plans',
      line: null,
      msg: 'no plan workspace under .claude/plans/*/ROADMAP.md — run /plan-project before /orchestrate',
    });
  }
  return report;
}

/** Share of a phase file's lines that may sit inside fenced code before the plan reads as implementing. */
const FENCED_CODE_SHARE_CAP = 0.1;

/**
 * Warns when fenced code exceeds a tenth of a phase file's lines. A phase records decisions and
 * acceptance, so a code-heavy one is writing the implementation into the plan. An unclosed fence
 * counts every line after it as fenced.
 */
export function checkFencedCodeShare(file: string, markdown: string): Report {
  const report = emptyReport();
  const lines = markdown.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let inFence = false;
  let fenced = 0;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) fenced += 1;
  }
  if (lines.length > 0 && fenced > lines.length * FENCED_CODE_SHARE_CAP) {
    report.findings.push({
      rule: 'plan-lint/fenced-code-share',
      level: 'warn',
      file,
      line: null,
      msg: `${fenced} of ${lines.length} lines are fenced code, over the ${FENCED_CODE_SHARE_CAP * 100} percent cap — record decisions and acceptance, not implementation`,
    });
  }
  return report;
}

/** Most items a phase's `## Review Focus` section may hold. */
const REVIEW_FOCUS_ITEM_CAP = 5;
const TEST_PATH_SUFFIXES = ['.ts', '.mts', '.mjs'];

function namesBacktickedPath(text: string): boolean {
  const spanRe = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = spanRe.exec(text))) {
    const span = match[1] ?? '';
    if (span.includes('/')) return true;
    if (TEST_PATH_SUFFIXES.some((suffix) => span.endsWith(suffix))) return true;
  }
  return false;
}

interface ReviewFocusItem {
  line: number;
  text: string;
}

/** The top-level bullets under `## Review Focus`, each carrying its wrapped continuation lines. */
function collectReviewFocusItems(
  lines: string[],
  start: number,
): ReviewFocusItem[] {
  const items: ReviewFocusItem[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^##\s/.test(line)) break;
    if (/^[-*]\s/.test(line)) {
      items.push({ line: index + 1, text: line });
    } else if (items.length > 0 && /^\s+\S/.test(line)) {
      const last = items[items.length - 1];
      if (last) last.text = `${last.text}\n${line}`;
    }
  }
  return items;
}

/**
 * Checks a phase's `## Review Focus` section: at most five top-level bullets, and each one names
 * the test that pins it as a backticked path. A phase with no section, or an empty one, passes.
 * Whether the named test exists is judged at phase close, not here.
 */
export function checkReviewFocus(file: string, markdown: string): Report {
  const report = emptyReport();
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^##\s+Review Focus\s*$/.test(line));
  if (start === -1) return report;

  const items = collectReviewFocusItems(lines, start);

  if (items.length > REVIEW_FOCUS_ITEM_CAP) {
    report.findings.push({
      rule: 'plan-lint/review-focus-count',
      level: 'warn',
      file,
      line: start + 1,
      msg: `## Review Focus has ${items.length} items, over the cap of ${REVIEW_FOCUS_ITEM_CAP}. Keep the ones no step's tests exercise`,
    });
  }
  for (const item of items) {
    if (namesBacktickedPath(item.text)) continue;
    report.findings.push({
      rule: 'plan-lint/review-focus-pin',
      level: 'warn',
      file,
      line: item.line,
      msg: `## Review Focus item on line ${item.line} names no backticked test path. Pin it to the test file in the step that owns the code`,
    });
  }
  return report;
}

const PATH_ROOT_FLOOR = ['packages/', '.claude/', 'scripts/'];
const PATH_ROOT_EXCLUDED = new Set(['node_modules', '.git', 'dist']);
const PATH_EXEMPT_CHARS = /[*?<>{}|$…]/;
/** A trailing `:36`, `:193-198`, or `:19,43` line annotation on a `path:line` reference. */
const LINE_SUFFIX_RE = /:\d+(-\d+)?(,\d+(-\d+)?)*$/;

/**
 * The path roots `checkPlanPaths` checks under, each ending in `/`: the top-level directories
 * of `root` less `node_modules`, `.git`, and `dist`, each configured target's `pathPrefix`,
 * and `packages/`, `.claude/`, and `scripts/` as a floor. Derive once per run.
 */
export function derivePathRoots(
  root: string,
  config: HouseConfig | null | undefined,
): string[] {
  const roots = new Set(PATH_ROOT_FLOOR);
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || PATH_ROOT_EXCLUDED.has(entry.name)) continue;
      roots.add(`${entry.name}/`);
    }
  } catch {
    // An unreadable root leaves the floor.
  }
  for (const target of config?.targets ?? []) {
    const prefix = target.pathPrefix;
    if (prefix === undefined || prefix === '') continue;
    roots.add(prefix.endsWith('/') ? prefix : `${prefix}/`);
  }
  return [...roots];
}

/**
 * Checks backtick-quoted paths in a phase doc against the filesystem, relative to `root`.
 * A token is checked when it starts with one of `roots` (see `derivePathRoots`), contains a
 * `/`, and has no whitespace or glob metacharacters. A token whose first segment is a
 * top-level file, not a directory, is never a root. This is the check that catches a plan
 * naming a file that was renamed, moved, or never existed, such as a `tsconfig.build.json`
 * a package never shipped.
 */
export function checkPlanPaths(
  file: string,
  markdown: string,
  root: string,
  roots: string[],
): Report {
  const report = emptyReport();
  const lines = markdown.split('\n');
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const tokenRe = /`([^`]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = tokenRe.exec(line))) {
      const token = match[1] ?? '';
      if (!roots.some((prefix) => token.startsWith(prefix))) continue;
      if (!token.includes('/')) continue;
      if (/\s/.test(token)) continue;
      if (PATH_EXEMPT_CHARS.test(token)) continue;

      const after = line.slice(match.index + match[0].length);
      if (/^\s?\(new\)/.test(after)) continue;

      const checkedToken = token.replace(LINE_SUFFIX_RE, '');
      let exists: boolean;
      try {
        exists = existsSync(join(root, checkedToken));
      } catch {
        continue;
      }
      if (exists) continue;

      report.findings.push({
        rule: 'plan-path/missing-file',
        level: 'warn',
        file,
        line: index + 1,
        msg: `path \`${token}\` does not exist in the repo`,
      });
    }
  });
  return report;
}

function parseStatusHeader(markdown: string): string | null {
  const match = markdown.match(/\*\*Status:\*\*\s*([^\n·]+)/);
  return match?.[1]?.trim() ?? null;
}

/** True when a `**Status:**` header value, parsed by `parseStatusHeader`, reads DONE. */
function isDoneStatus(status: string | null): boolean {
  return status !== null && /^DONE\b/.test(status);
}

const PLANS_ROOT = '.claude/plans';

/**
 * Warns when a sub-plan's Domain sits wholly inside the plan workspaces and the phase lacks
 * the `flat` signal. Such a phase edits only plan files, so a phase-orchestrator costs more than it saves.
 * The caller skips closed phases.
 */
export function checkWorkspacePhaseFlat(
  file: string,
  markdown: string,
): Report {
  const report = emptyReport();
  const roots = parseDomain(markdown);
  if (roots === null || roots.length === 0) return report;
  if (parseSignals(markdown).includes(FLAT_SIGNAL)) return report;
  const isInsidePlans = (root: string): boolean =>
    root === PLANS_ROOT || root.startsWith(`${PLANS_ROOT}/`);
  if (!roots.every(isInsidePlans)) return report;
  report.findings.push({
    rule: 'plan-lint/workspace-phase-not-flat',
    level: 'warn',
    file,
    line: null,
    msg: `sub-plan "${file}" has a Domain wholly inside ${PLANS_ROOT}, add the \`flat\` signal so the dispatcher runs it in its own context`,
  });
  return report;
}

/** True when a phase status is terminal, DONE or DROPPED, so its paths are no longer checked. */
function isClosedPhaseStatus(status: string | null): boolean {
  return isDoneStatus(status) || isDroppedStatus(status);
}

/**
 * True when a workspace `**Status:**` header reads DONE or SUPERSEDED. Only the
 * workspace-level ROADMAP header counts as archived this way, not an individual phase doc's
 * own header, since a superseded plan is retired as a whole rather than phase by phase.
 */
function isArchivedWorkspaceStatus(status: string | null): boolean {
  return (
    isDoneStatus(status) || (status !== null && /^SUPERSEDED\b/.test(status))
  );
}

/** The names directly inside `dir`, or none when it is missing or unreadable. */
function listEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The subdirectory names directly inside `dir`, or none when it is missing or unreadable. */
function listSubdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

type Finding = Report['findings'][number];

const ROADMAP_FILE = 'ROADMAP.md';
const MILESTONE_FILE = 'MILESTONE.md';
const PHASE_FILE = /^phase-.*\.md$/;
/** A sub-plan filename whose `<slug>` group is the phase slug a milestone item names. */
const PHASE_FILE_SLUG = /^phase-\d+-(.+)\.md$/;

/** What a phase file's header says, as its ROADMAP checks and the milestone checks read it. */
interface SubplanFacts {
  status: string | null;
  domain: string[] | null;
  signals: string[];
}

/** One plan workspace's findings, and its ROADMAP phases in the shape the milestone checks read. */
interface WorkspaceLint {
  findings: Finding[];
  phases: MemberPhase[];
}

/**
 * Runs every per-file check over one phase file. Path checks are skipped when `shouldSkipPathChecks`
 * is set or the phase itself is closed.
 */
function lintPhaseFile(
  root: string,
  phasePath: string,
  shouldSkipPathChecks: boolean,
  roots: string[],
): { findings: Finding[]; facts: SubplanFacts } {
  const markdown = readFileSync(phasePath, 'utf8');
  const relativeFile = relative(root, phasePath);
  const status = parseStatusHeader(markdown);
  const findings = [
    ...checkSliceStatuses(relativeFile, markdown).findings,
    ...checkSliceRowsAfterDone(relativeFile, markdown).findings,
    ...checkFencedCodeShare(relativeFile, markdown).findings,
    ...checkReviewFocus(relativeFile, markdown).findings,
    ...checkSignals(relativeFile, markdown).findings,
  ];
  if (!shouldSkipPathChecks && !isClosedPhaseStatus(status)) {
    findings.push(
      ...checkPlanPaths(relativeFile, markdown, root, roots).findings,
    );
  }
  if (!isClosedPhaseStatus(status)) {
    findings.push(...checkWorkspacePhaseFlat(relativeFile, markdown).findings);
  }
  return {
    findings,
    facts: {
      status,
      domain: parseDomain(markdown),
      signals: parseSignals(markdown),
    },
  };
}

/** The phase slug of a sub-plan link, the `<slug>` of `phase-N-<slug>.md`, or its bare name otherwise. */
function phaseSlugOf(subplan: string): string {
  const name = basename(subplan);
  return name.match(PHASE_FILE_SLUG)?.[1] ?? name.replace(/\.md$/, '');
}

/** Each ROADMAP phase line joined to its sub-plan's header facts. */
function memberPhasesOf(
  roadmapMarkdown: string,
  facts: Record<string, SubplanFacts>,
): MemberPhase[] {
  return parseRoadmapPhases(roadmapMarkdown).map((phase) => ({
    number: phase.number,
    slug: phaseSlugOf(phase.subplan),
    status: phase.status,
    domain: facts[phase.subplan]?.domain ?? null,
    signals: facts[phase.subplan]?.signals ?? [],
  }));
}

/** One field of each sub-plan's facts, keyed by sub-plan filename. */
function factFieldBySubplan<TValue>(
  facts: Record<string, SubplanFacts>,
  pick: (fact: SubplanFacts) => TValue,
): Record<string, TValue> {
  return Object.fromEntries(
    Object.entries(facts).map(([name, fact]) => [name, pick(fact)]),
  );
}

/** The ROADMAP-level checks: its sync with each sub-plan, and its phase schedule. */
function lintRoadmap(
  root: string,
  roadmapPath: string,
  roadmapMarkdown: string,
  facts: Record<string, SubplanFacts>,
): Finding[] {
  const relativeFile = relative(root, roadmapPath);
  return [
    ...checkRoadmapSync(
      relativeFile,
      roadmapMarkdown,
      factFieldBySubplan(facts, (fact) => fact.status),
    ).findings,
    ...checkPhaseSchedule(
      relativeFile,
      roadmapMarkdown,
      factFieldBySubplan(facts, (fact) => fact.domain),
      factFieldBySubplan(facts, (fact) => fact.signals),
    ).findings,
  ];
}

/**
 * Lints one plan workspace with every ordinary check. Path checks are skipped when its own
 * ROADMAP is archived, or when `isArchivedByMilestone` says the milestone holding it is.
 * Finding paths are relative to `root`.
 */
function lintPlanWorkspace(
  root: string,
  workspaceDir: string,
  isArchivedByMilestone: boolean,
  roots: string[],
): WorkspaceLint {
  let entries: string[];
  try {
    entries = readdirSync(workspaceDir);
  } catch {
    return { findings: [], phases: [] };
  }

  const roadmapPath = join(workspaceDir, ROADMAP_FILE);
  const roadmapMarkdown = existsSync(roadmapPath)
    ? readFileSync(roadmapPath, 'utf8')
    : null;
  const shouldSkipPathChecks =
    isArchivedByMilestone ||
    isArchivedWorkspaceStatus(
      roadmapMarkdown === null ? null : parseStatusHeader(roadmapMarkdown),
    );

  const findings: Finding[] = [];
  const facts: Record<string, SubplanFacts> = {};
  for (const name of entries.filter((entry) => PHASE_FILE.test(entry))) {
    const linted = lintPhaseFile(
      root,
      join(workspaceDir, name),
      shouldSkipPathChecks,
      roots,
    );
    findings.push(...linted.findings);
    facts[name] = linted.facts;
  }

  if (roadmapMarkdown === null) return { findings, phases: [] };
  findings.push(...lintRoadmap(root, roadmapPath, roadmapMarkdown, facts));
  return { findings, phases: memberPhasesOf(roadmapMarkdown, facts) };
}

/** A milestone directory and the names of its subdirectories that hold `ROADMAP.md`. */
interface MilestoneLayout {
  slug: string;
  memberDirs: string[];
}

/** The directories directly under `.claude/plans/`, split into ordinary plans and milestones. */
interface PlansLayout {
  planDirs: string[];
  milestones: MilestoneLayout[];
}

/**
 * Reads `.claude/plans/` two levels deep. A directory holding `MILESTONE.md` is a milestone, and
 * each of its subdirectories holding `ROADMAP.md` is a member. A member's own subdirectories are
 * never read. Every other directory is an ordinary plan, as before milestones existed.
 */
function discoverPlans(plansDir: string): PlansLayout {
  const layout: PlansLayout = { planDirs: [], milestones: [] };
  for (const slug of listSubdirectories(plansDir)) {
    const dir = join(plansDir, slug);
    if (!existsSync(join(dir, MILESTONE_FILE))) {
      layout.planDirs.push(slug);
      continue;
    }
    layout.milestones.push({
      slug,
      memberDirs: listSubdirectories(dir).filter((name) =>
        existsSync(join(dir, name, ROADMAP_FILE)),
      ),
    });
  }
  return layout;
}

/** Every directory a plan or an impact map may live in, relative to `.claude/plans/`. */
function workspaceHomes(layout: PlansLayout): string[] {
  return [
    ...layout.planDirs,
    ...layout.milestones.flatMap((milestone) => [
      milestone.slug,
      ...milestone.memberDirs.map((member) => join(milestone.slug, member)),
    ]),
  ];
}

/** The three discovery errors: a milestone holding `ROADMAP.md`, and a member table out of step with the directories. */
function milestoneDiscoveryErrors(
  root: string,
  milestoneDir: string,
  milestone: Milestone,
  memberDirs: string[],
): Finding[] {
  const file = relative(root, join(milestoneDir, MILESTONE_FILE));
  const findings: Finding[] = [];
  const roadmapPath = join(milestoneDir, ROADMAP_FILE);
  if (existsSync(roadmapPath)) {
    findings.push(
      milestoneError(
        'milestone/has-roadmap',
        relative(root, roadmapPath),
        null,
        'this directory holds MILESTONE.md, so it is a milestone, not a plan, and must not hold ROADMAP.md',
      ),
    );
  }
  const listed = milestone.members.map((member) => member.name);
  for (const name of listed.filter(
    (listedName) => !memberDirs.includes(listedName),
  )) {
    findings.push(
      milestoneError(
        'milestone/member-missing',
        file,
        null,
        `member \`${name}\` is in the ## Members table, but ${relative(root, join(milestoneDir, name, ROADMAP_FILE))} does not exist`,
      ),
    );
  }
  for (const name of memberDirs.filter(
    (memberDir) => !listed.includes(memberDir),
  )) {
    findings.push(
      milestoneError(
        'milestone/member-unlisted',
        file,
        null,
        `${relative(root, join(milestoneDir, name))} holds ROADMAP.md, but \`${name}\` is not in the ## Members table`,
      ),
    );
  }
  return findings;
}

/** The sixteen per-milestone checks, in check order. */
const MILESTONE_CHECKS: Array<
  (file: string, milestone: Milestone, members: MemberPlans) => Report
> = [
  checkMilestoneUnknownItems,
  checkMilestoneDuplicatePhaseSlugs,
  checkMilestonePhaseInTwoSteps,
  checkMilestoneStepDoneEarly,
  checkMilestoneStepTodoLate,
  checkMilestoneOneOpenStep,
  checkMilestoneOpenGates,
  checkMilestoneNeedsMatchBlocks,
  checkMilestoneBarRecorded,
  checkMilestoneItemDomains,
  checkMilestoneHeldPathOverlap,
  checkMilestoneLiveItems,
  checkMilestoneResources,
  checkMilestoneOwnerItems,
  checkMilestoneContracts,
  checkMilestoneUnscheduledPhases,
];

/**
 * Lints one milestone: its discovery errors, every member as a plan, then the sixteen milestone
 * checks over the members' phases. A `DONE` milestone skips path checks for every member.
 */
function lintMilestone(
  root: string,
  plansDir: string,
  layout: MilestoneLayout,
  roots: string[],
): Finding[] {
  const milestoneDir = join(plansDir, layout.slug);
  const milestonePath = join(milestoneDir, MILESTONE_FILE);
  const milestone = parseMilestone(readFileSync(milestonePath, 'utf8'));
  const isArchived = isDoneStatus(milestone.status);
  const findings = milestoneDiscoveryErrors(
    root,
    milestoneDir,
    milestone,
    layout.memberDirs,
  );

  const members: MemberPlans = {};
  for (const member of layout.memberDirs) {
    const linted = lintPlanWorkspace(
      root,
      join(milestoneDir, member),
      isArchived,
      roots,
    );
    findings.push(...linted.findings);
    members[member] = linted.phases;
  }

  const file = relative(root, milestonePath);
  for (const check of MILESTONE_CHECKS) {
    findings.push(...check(file, milestone, members).findings);
  }
  return findings;
}

/**
 * One line per gate blocking `step`, as `G<n> · <state> · blocks <step>` in gate order, or a
 * single `no gates block <step>` line when none does.
 */
export function formatGateLines(milestone: Milestone, step: string): string[] {
  const lines = milestone.gates
    .filter((gate) => gate.blocks === step)
    .map((gate) => `${gate.id} · ${gate.state} · blocks ${step}`);
  return lines.length > 0 ? lines : [`no gates block ${step}`];
}

/** Exit code for a malformed `--gates` call or an unreadable milestone, apart from lint's 0 and 1. */
const USAGE_ERROR_EXIT_CODE = 2;

/** The `--gates <milestone-dir> <step>` mode: prints the gate lines and exits. */
function runGates(args: string[]): never {
  const [milestoneDir, step] = args;
  if (milestoneDir === undefined || step === undefined) {
    process.stderr.write('usage: plan-lint --gates <milestone-dir> <step>\n');
    process.exit(USAGE_ERROR_EXIT_CODE);
  }
  const milestonePath = join(resolve(milestoneDir), MILESTONE_FILE);
  let markdown: string;
  try {
    markdown = readFileSync(milestonePath, 'utf8');
  } catch {
    process.stderr.write(`plan-lint: cannot read ${milestonePath}\n`);
    process.exit(USAGE_ERROR_EXIT_CODE);
  }
  const lines = formatGateLines(parseMilestone(markdown), step);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === '--gates') runGates(args.slice(1));
  const root = repoRootSafe() ?? process.cwd();
  const plansDir = join(root, '.claude/plans');
  const report = emptyReport();
  report.declined.push(...DECLINED);

  for (const arg of args) {
    report.findings.push({
      rule: 'checker/unexpected-argument',
      level: 'error',
      file: arg,
      line: null,
      msg: 'plan-lint takes no arguments except `--gates <milestone-dir> <step>` and scans .claude/plans/ itself, so this path was not read',
    });
  }

  const layout = discoverPlans(plansDir);
  const homes = workspaceHomes(layout);
  report.findings.push(...checkNoPlanWorkspace(homes).findings);

  const config = loadConfigSafe();
  report.findings.push(...checkFixOnSubagentStop(config).findings);
  const roots = derivePathRoots(root, config);

  for (const slug of layout.planDirs) {
    report.findings.push(
      ...lintPlanWorkspace(root, join(plansDir, slug), false, roots).findings,
    );
  }
  for (const milestone of layout.milestones) {
    report.findings.push(...lintMilestone(root, plansDir, milestone, roots));
  }

  for (const filePath of listImpactMaps(plansDir, homes)) {
    report.findings.push(
      ...checkBlastRadiusShape(
        relative(root, filePath),
        readFileSync(filePath, 'utf8'),
      ).findings,
    );
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
