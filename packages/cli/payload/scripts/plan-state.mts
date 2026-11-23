#!/usr/bin/env node
/**
 * Reads a `.claude/plans/<slug>/` workspace and reports each phase's state.
 *
 * Usage:
 *   plan-state.mjs show <workspace> [--json]
 *   plan-state.mjs set <workspace> <phase> <status> [--log <line>]
 *   plan-state.mjs set <workspace> <phase> --slice <id> <status> [--log <line>]
 *   plan-state.mjs set <workspace> --log <line>
 *
 * `<workspace>` is a directory holding `ROADMAP.md`, absolute or relative to the current
 * directory. For each ROADMAP phase line it prints the ROADMAP status, the sub-plan's
 * `**Status:**` header, and the `## Slices` table rows. A phase whose two statuses differ is
 * flagged as a mismatch, which is data and still exits 0. A missing workspace, a missing
 * `ROADMAP.md`, or a ROADMAP with no phase line exits 1 with one message naming the path. No
 * arguments or an unknown subcommand exits 2 with a usage line.
 *
 * `set` writes a phase status (ROADMAP line, checkbox, date, `**Updated:**`, and the sub-plan
 * `**Status:**` header) or one slice row, and `--log` appends a dated line to the ROADMAP
 * `## Log`. `<phase>` is a phase number or a sub-plan slug. A status outside its vocabulary,
 * or malformed arguments, exits 2. An unknown phase or slice, a missing Slices table or Log
 * section, or a milestone directory exits 1. Every refusal writes nothing, and a failed
 * sub-plan write restores the ROADMAP.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  parseRoadmapPhases,
  parseSliceTable,
  parseStatusHeader,
  ROADMAP_PHASE_LINE,
  type RoadmapPhase,
  PHASE_STATUSES,
  SLICE_STATUSES,
} from '@houserules/payload/plan-markdown';

const USAGE = [
  'usage: plan-state.mjs show <workspace> [--json]',
  '       plan-state.mjs set <workspace> <phase> <status> [--log <line>]',
  '       plan-state.mjs set <workspace> <phase> --slice <id> <status> [--log <line>]',
  '       plan-state.mjs set <workspace> --log <line>',
].join('\n');
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

interface SliceState {
  id: string;
  owns: string;
  depends: string;
  wave: string;
  status: string;
}

interface PhaseState {
  number: number;
  slug: string;
  roadmapStatus: string;
  headerStatus: string | null;
  mismatch: boolean;
  slices: SliceState[];
}

interface PlanState {
  workspace: string;
  kind: 'plan' | 'member';
  phases: PhaseState[];
}

class PlanStateError extends Error {}

class UsageError extends Error {}

function readSlices(markdown: string): SliceState[] {
  const table = parseSliceTable(markdown);
  if (table === null) return [];
  const names = table.header.map((cell) => cell.toLowerCase());
  const cellOf = (row: string[], name: string): string => {
    const index = names.indexOf(name);
    return index === -1 ? '' : (row[index] ?? '').trim();
  };
  return table.rows.map((row) => ({
    id: cellOf(row, 'id'),
    owns: cellOf(row, 'owns'),
    depends: cellOf(row, 'depends'),
    wave: cellOf(row, 'wave'),
    status: cellOf(row, 'status'),
  }));
}

function slugOf(subplan: string, number: number): string {
  const match = basename(subplan).match(/^phase-\d+-(.+)\.md$/);
  return match?.[1] ?? `phase-${number}`;
}

/** Reads one ROADMAP phase and its sub-plan, which may not exist yet. */
function readPhaseState(dir: string, phase: RoadmapPhase): PhaseState {
  const subplanPath = resolve(dir, phase.subplan);
  const markdown = existsSync(subplanPath)
    ? readFileSync(subplanPath, 'utf8')
    : null;
  const headerStatus = markdown === null ? null : parseStatusHeader(markdown);
  return {
    number: phase.number,
    slug: slugOf(phase.subplan, phase.number),
    roadmapStatus: phase.status,
    headerStatus,
    mismatch: headerStatus !== null && headerStatus !== phase.status,
    slices: markdown === null ? [] : readSlices(markdown),
  };
}

/** Reads one workspace into its phases. Throws `PlanStateError` naming the path on a bad workspace. */
function readPlanState(workspace: string): PlanState {
  const dir = resolve(workspace);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new PlanStateError(`workspace not found: ${workspace}`);
  }
  const roadmapPath = join(dir, 'ROADMAP.md');
  if (!existsSync(roadmapPath)) {
    throw new PlanStateError(`ROADMAP.md not found: ${roadmapPath}`);
  }
  const roadmapPhases = parseRoadmapPhases(readFileSync(roadmapPath, 'utf8'));
  if (roadmapPhases.length === 0) {
    throw new PlanStateError(
      `unparseable ROADMAP, no phase lines found: ${roadmapPath}`,
    );
  }
  const phases = roadmapPhases.map((phase) => readPhaseState(dir, phase));
  const kind = existsSync(join(dirname(dir), 'MILESTONE.md'))
    ? 'member'
    : 'plan';
  return { workspace, kind, phases };
}

/** Renders the plain-text form, one block per phase, with `MISMATCH` on a phase whose statuses differ. */
function renderState(state: PlanState): string {
  const lines = [`${state.workspace} (${state.kind})`];
  for (const phase of state.phases) {
    const header = phase.headerStatus ?? '(no sub-plan)';
    const flag = phase.mismatch ? '  MISMATCH' : '';
    lines.push(
      '',
      `Phase ${phase.number} ${phase.slug}`,
      `  roadmap: ${phase.roadmapStatus}  header: ${header}${flag}`,
    );
    for (const slice of phase.slices) {
      lines.push(
        `  ${slice.id} | ${slice.owns} | depends ${slice.depends} | wave ${slice.wave} | ${slice.status}`,
      );
    }
  }
  return lines.join('\n');
}

type PhaseStatus = (typeof PHASE_STATUSES)[number];

const CHECKBOX_OF: Record<PhaseStatus, string> = {
  TODO: ' ',
  'IN PROGRESS': '~',
  BLOCKED: '~',
  DONE: 'x',
  DROPPED: 'x',
};

const DATED_STATUSES: readonly string[] = ['DONE', 'DROPPED'];

interface SetRequest {
  workspace: string;
  phase: string | null;
  status: string | null;
  sliceId: string | null;
  log: string | null;
}

/** Local date as `YYYY-MM-DD`. */
function localDate(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Reads the arguments after `set`, or `null` when they fit none of the three forms. */
function parseSetArgs(args: string[]): SetRequest | null {
  const positional: string[] = [];
  let sliceId: string | null = null;
  let log: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--slice' || arg === '--log') {
      const value = args[index + 1];
      if (value === undefined) return null;
      if (arg === '--slice') sliceId = value;
      else log = value;
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  const [workspace, phase, status, ...extra] = positional;
  if (workspace === undefined || extra.length > 0) return null;
  if (log !== null && (log.trim() === '' || log.includes('\n'))) return null;
  if (phase === undefined) {
    return log === null || sliceId !== null
      ? null
      : { workspace, phase: null, status: null, sliceId, log };
  }
  if (status === undefined) return null;
  return { workspace, phase, status, sliceId, log };
}

/** Refuses a status outside the vocabulary of what is being set. */
function assertKnownStatus(request: SetRequest): void {
  if (request.status === null) return;
  const isSlice = request.sliceId !== null;
  const vocabulary: readonly string[] = isSlice
    ? SLICE_STATUSES
    : PHASE_STATUSES;
  if (vocabulary.includes(request.status)) return;
  throw new UsageError(
    `${isSlice ? 'slice' : 'phase'} status "${request.status}" is not one of: ${vocabulary.join(', ')}`,
  );
}

function milestoneMembers(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(dir, entry.name, 'ROADMAP.md')),
    )
    .map((entry) => entry.name)
    .sort();
}

/** Finds the ROADMAP phase `<phase>` names, by number when it is a bare integer and by sub-plan slug otherwise. */
function findPhase(phases: RoadmapPhase[], phase: string): RoadmapPhase {
  const found = /^\d+$/.test(phase)
    ? phases.find((candidate) => candidate.number === Number(phase))
    : phases.find(
        (candidate) => slugOf(candidate.subplan, candidate.number) === phase,
      );
  if (found === undefined) {
    const known = phases
      .map((candidate) => slugOf(candidate.subplan, candidate.number))
      .join(', ');
    throw new PlanStateError(`no phase matches "${phase}", known: ${known}`);
  }
  return found;
}

function statusText(status: string, date: string): string {
  return DATED_STATUSES.includes(status) ? `${status} (${date})` : status;
}

/** Replaces the status cell and checkbox on the ROADMAP line of phase `number`. */
function rewritePhaseLine(
  roadmap: string,
  number: number,
  status: PhaseStatus,
  date: string,
): string {
  const lines = roadmap.split('\n');
  const lineRe = new RegExp(ROADMAP_PHASE_LINE.source);
  for (const [index, line] of lines.entries()) {
    const match = lineRe.exec(line);
    if (match === null || Number(match[1]) !== number) continue;
    const cell = match[2] as string;
    const cellStart = line.indexOf(cell, line.indexOf('Status:'));
    const trailing = /\s*$/.exec(cell)?.[0] ?? '';
    const rewritten =
      line.slice(0, cellStart) +
      statusText(status, date) +
      trailing +
      line.slice(cellStart + cell.length);
    lines[index] = rewritten.replace(
      /^(\s*[-*]\s*\[)[ x~](\])/,
      (_whole, open: string, close: string) =>
        `${open}${CHECKBOX_OF[status]}${close}`,
    );
    return lines.join('\n');
  }
  throw new PlanStateError(`ROADMAP line for phase ${number} not found`);
}

function bumpUpdated(markdown: string, date: string): string {
  return markdown.replace(
    /(\*\*Updated:\*\*\s*)[^\s·]+/,
    (_whole, label: string) => `${label}${date}`,
  );
}

/** Appends `- <date>: <line>` after the last non-blank line of the `## Log` section. */
function appendLog(roadmap: string, line: string, date: string): string {
  const lines = roadmap.split('\n');
  const heading = lines.findIndex((candidate) => /^## Log\s*$/.test(candidate));
  if (heading === -1) throw new PlanStateError('ROADMAP has no ## Log section');
  let end = lines.findIndex(
    (candidate, index) => index > heading && candidate.startsWith('## '),
  );
  if (end === -1) end = lines.length;
  let last = heading;
  for (let index = heading + 1; index < end; index += 1) {
    if ((lines[index] as string).trim() !== '') last = index;
  }
  lines.splice(last + 1, 0, `- ${date}: ${line}`);
  return lines.join('\n');
}

/** Replaces the first `**Status:**` value, up to the first `·` or the end of the line. */
function rewriteHeader(subplan: string, status: string): string {
  const header = /(\*\*Status:\*\*\s*)([^\n·]+)/;
  const match = header.exec(subplan);
  if (match === null)
    throw new PlanStateError('sub-plan has no **Status:** header');
  const trailing = /\s*$/.exec(match[2] as string)?.[0] ?? '';
  return subplan.replace(
    header,
    (_whole, label: string) => `${label}${status}${trailing}`,
  );
}

/** Replaces the status cell of the slice row `sliceId`, keeping the table's padding. */
function rewriteSliceRow(
  subplan: string,
  sliceId: string,
  status: string,
): string {
  const table = parseSliceTable(subplan);
  if (table === null)
    throw new PlanStateError('sub-plan has no ## Slices table');
  const names = table.header.map((cell) => cell.toLowerCase());
  const idColumn = names.indexOf('id');
  const statusColumn = names.indexOf('status');
  if (idColumn === -1 || statusColumn === -1) {
    throw new PlanStateError('Slices table needs id and status columns');
  }
  const row = table.rows.findIndex((cells) => cells[idColumn] === sliceId);
  if (row === -1)
    throw new PlanStateError(`no slice "${sliceId}" in the table`);
  const lines = subplan.split('\n');
  const lineIndex = (table.rowLines[row] as number) - 1;
  const parts = (lines[lineIndex] as string).split('|');
  const old = parts[statusColumn + 1] as string;
  const leading = /^\s*/.exec(old)?.[0] ?? '';
  parts[statusColumn + 1] =
    `${leading}${status} `.length <= old.length
      ? `${leading}${status}`.padEnd(old.length)
      : ` ${status} `;
  lines[lineIndex] = parts.join('|');
  return lines.join('\n');
}

/** Writes the ROADMAP then the sub-plan, restoring the ROADMAP when the second write fails. */
function writeBoth(
  roadmap: { path: string; before: string; after: string } | null,
  subplan: { path: string; after: string } | null,
): void {
  if (roadmap !== null) writeFileSync(roadmap.path, roadmap.after);
  if (subplan === null) return;
  try {
    writeFileSync(subplan.path, subplan.after);
  } catch (error) {
    if (roadmap !== null) writeFileSync(roadmap.path, roadmap.before);
    throw new PlanStateError(
      `could not write ${subplan.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Resolves a workspace to its ROADMAP path. Throws naming the members when it is a milestone directory. */
function resolveRoadmapPath(workspace: string): {
  dir: string;
  roadmapPath: string;
} {
  const dir = resolve(workspace);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new PlanStateError(`workspace not found: ${workspace}`);
  }
  const roadmapPath = join(dir, 'ROADMAP.md');
  if (existsSync(roadmapPath)) return { dir, roadmapPath };
  if (!existsSync(join(dir, 'MILESTONE.md'))) {
    throw new PlanStateError(`ROADMAP.md not found: ${roadmapPath}`);
  }
  const members = milestoneMembers(dir).map(
    (name) => `${workspace.replace(/\/+$/, '')}/${name}`,
  );
  throw new PlanStateError(
    `${workspace} is a milestone directory, name a member plan: ${members.join(', ') || '(no member holds a ROADMAP.md)'}`,
  );
}

/** Applies one `set` request. Computes every new content first, so a refusal writes nothing. */
function setState(request: SetRequest): void {
  const { dir, roadmapPath } = resolveRoadmapPath(request.workspace);
  const date = localDate();
  const before = readFileSync(roadmapPath, 'utf8');
  let roadmap = before;
  let isRoadmapChanged = false;
  let subplan: { path: string; after: string } | null = null;
  if (request.phase !== null && request.status !== null) {
    const phase = findPhase(parseRoadmapPhases(before), request.phase);
    const subplanPath = resolve(dir, phase.subplan);
    if (!existsSync(subplanPath)) {
      throw new PlanStateError(`sub-plan not found: ${subplanPath}`);
    }
    const current = readFileSync(subplanPath, 'utf8');
    if (request.sliceId === null) {
      const status = request.status as PhaseStatus;
      roadmap = rewritePhaseLine(roadmap, phase.number, status, date);
      isRoadmapChanged = true;
      subplan = {
        path: subplanPath,
        after: rewriteHeader(current, statusText(status, date)),
      };
    } else {
      subplan = {
        path: subplanPath,
        after: rewriteSliceRow(current, request.sliceId, request.status),
      };
    }
  }
  if (request.log !== null) {
    roadmap = appendLog(roadmap, request.log, date);
    isRoadmapChanged = true;
  }
  writeBoth(
    isRoadmapChanged
      ? { path: roadmapPath, before, after: bumpUpdated(roadmap, date) }
      : null,
    subplan,
  );
}

function runSet(args: string[]): number {
  const request = parseSetArgs(args);
  if (request === null) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  try {
    assertKnownStatus(request);
    setState(request);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`plan-state: ${error.message}\n`);
      return EXIT_USAGE;
    }
    if (!(error instanceof PlanStateError)) throw error;
    process.stderr.write(`plan-state: ${error.message}\n`);
    return EXIT_FAILURE;
  }
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === 'set') return runSet(rest);
  const wantsJson = rest.includes('--json');
  const positional = rest.filter((arg) => arg !== '--json');
  const workspace = positional[0];
  if (command !== 'show' || workspace === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  try {
    const state = readPlanState(workspace);
    process.stdout.write(
      `${wantsJson ? JSON.stringify(state, null, 2) : renderState(state)}\n`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof PlanStateError)) throw error;
    process.stderr.write(`plan-state: ${error.message}\n`);
    return EXIT_FAILURE;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  process.exit(main(process.argv.slice(2)));
}
