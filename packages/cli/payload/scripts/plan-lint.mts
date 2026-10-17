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
 *
 * Scans every `.claude/plans/*` workspace and impact-map file in the repo. Takes no
 * arguments, because the object under check is the whole `.claude/plans/` tree, not a file
 * list a caller would otherwise have to enumerate itself.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
];

interface SliceTable {
  header: string[];
  rows: string[][];
}

/** Finds the `## Slices` markdown table in a phase sub-plan, if it has one. */
function parseSliceTable(markdown: string): SliceTable | null {
  const start = markdown.indexOf('## Slices');
  if (start === -1) return null;
  const lines: string[] = [];
  for (const line of markdown.slice(start).split('\n')) {
    if (line.trim().startsWith('|')) lines.push(line);
    else if (lines.length > 0) break;
  }
  if (lines.length < 2 || lines[0] === undefined) return null;
  const splitRow = (line: string): string[] => {
    const cells = line.split('|').map((cell) => cell.trim());
    while (cells.length > 0 && cells[0] === '') cells.shift();
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    return cells;
  };
  const header = splitRow(lines[0]);
  const rows = lines
    .slice(2)
    .map(splitRow)
    .filter((cells) => cells.length >= 2);
  return { header, rows };
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
 * The ROADMAP phase line, shared by `checkRoadmapSync` and `parseRoadmapPhases` so the two
 * read one grammar. Groups: phase number, status cell, sub-plan file, and the optional
 * trailing `After` text. The group takes whatever follows `After:` so a malformed value is
 * seen, not silently read as the chain; `parseRoadmapPhases` decides whether it is `none` or a
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
    const m = status.match(/^(TODO|IN PROGRESS|DONE|BLOCKED)\b/);
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
 * Checks that the `After` markers on a ROADMAP and the `**Domain:**` roots of its sub-plans
 * describe a schedule that can run. It errors on an `After` naming an unknown phase or its own
 * phase, on a cycle, on a glob character in a root, and on any two phases that neither
 * depends on the other through `After` when either has no domain or their roots overlap.
 * A phase in a cycle or with a bad `After` is left out of the concurrency pairs, since its
 * ordering is already reported. A workspace with no markers is a total order, so it has no
 * concurrent pair and reports nothing.
 *
 * `subplanDomains` maps each sub-plan filename to its parsed roots, or `null` when the file
 * is missing or has no `**Domain:**` line. An empty array is a `**Domain:**` line with no
 * backticked root, which is an error.
 */
export function checkPhaseSchedule(
  roadmapFile: string,
  roadmapMarkdown: string,
  subplanDomains: Record<string, string[] | null>,
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
      if (inCycle(first.number) || inCycle(second.number)) continue;
      if (broken.has(first.number) || broken.has(second.number)) continue;
      if (ancestors.get(first.number)?.has(second.number)) continue;
      if (ancestors.get(second.number)?.has(first.number)) continue;
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

/**
 * Flags the case `orchestrate/SKILL.md` §0 names as its own precondition: no plan workspace
 * to slice. `planWorkspaceDirs` is every directory found directly under `.claude/plans/`.
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

const PATH_CHECK_PREFIXES = ['packages/', '.claude/', 'scripts/'];
const PATH_EXEMPT_CHARS = /[*?<>{}|$]/;
/** A trailing `:36`, `:193-198`, or `:19,43` line annotation on a `path:line` reference. */
const LINE_SUFFIX_RE = /:\d+(-\d+)?(,\d+(-\d+)?)*$/;

/**
 * Checks backtick-quoted paths in a phase doc against the filesystem, relative to `root`.
 * A token is checked when it starts with `packages/`, `.claude/`, or `scripts/`, contains a
 * `/`, and has no whitespace or glob metacharacters. This is the check that catches a plan
 * naming a file that was renamed, moved, or never existed, such as a `tsconfig.build.json`
 * a package never shipped.
 */
export function checkPlanPaths(
  file: string,
  markdown: string,
  root: string,
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
      if (!PATH_CHECK_PREFIXES.some((prefix) => token.startsWith(prefix)))
        continue;
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

function listSubdirectories(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function main(): void {
  const root = repoRootSafe() ?? process.cwd();
  const plansDir = join(root, '.claude/plans');
  const report = emptyReport();
  report.declined.push(...DECLINED);

  const workspaceDirs = existsSync(plansDir)
    ? listSubdirectories(plansDir)
    : [];
  report.findings.push(...checkNoPlanWorkspace(workspaceDirs).findings);

  const config = loadConfigSafe();
  report.findings.push(...checkFixOnSubagentStop(config).findings);

  for (const slug of workspaceDirs) {
    const workspaceDir = join(plansDir, slug);
    let entries: string[];
    try {
      entries = readdirSync(workspaceDir);
    } catch {
      continue;
    }

    const roadmapPath = join(workspaceDir, 'ROADMAP.md');
    const roadmapMarkdown = existsSync(roadmapPath)
      ? readFileSync(roadmapPath, 'utf8')
      : null;
    const workspaceArchived = isArchivedWorkspaceStatus(
      roadmapMarkdown === null ? null : parseStatusHeader(roadmapMarkdown),
    );

    const phaseFiles = entries.filter((name) => /^phase-.*\.md$/.test(name));
    const subplanStatuses: Record<string, string | null> = {};
    const subplanDomains: Record<string, string[] | null> = {};
    for (const name of phaseFiles) {
      const phasePath = join(workspaceDir, name);
      const markdown = readFileSync(phasePath, 'utf8');
      const relFile = relative(root, phasePath);
      report.findings.push(...checkSliceStatuses(relFile, markdown).findings);
      report.findings.push(...checkFencedCodeShare(relFile, markdown).findings);
      report.findings.push(...checkReviewFocus(relFile, markdown).findings);
      const phaseStatus = parseStatusHeader(markdown);
      if (!workspaceArchived && !isDoneStatus(phaseStatus)) {
        report.findings.push(
          ...checkPlanPaths(relFile, markdown, root).findings,
        );
      }
      subplanStatuses[name] = phaseStatus;
      subplanDomains[name] = parseDomain(markdown);
    }

    if (roadmapMarkdown !== null) {
      const relFile = relative(root, roadmapPath);
      report.findings.push(
        ...checkRoadmapSync(relFile, roadmapMarkdown, subplanStatuses).findings,
      );
      report.findings.push(
        ...checkPhaseSchedule(relFile, roadmapMarkdown, subplanDomains)
          .findings,
      );
    }
  }

  if (existsSync(plansDir)) {
    for (const name of readdirSync(plansDir)) {
      if (!/^blast-radius-.*\.md$/.test(name)) continue;
      const filePath = join(plansDir, name);
      const markdown = readFileSync(filePath, 'utf8');
      const relFile = relative(root, filePath);
      report.findings.push(
        ...checkBlastRadiusShape(relFile, markdown).findings,
      );
    }
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
