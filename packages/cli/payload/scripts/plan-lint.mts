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
  const lineRe =
    /\*\*Phase \d+[^*]*\*\*\s*·\s*Status:\s*([A-Z][A-Za-z ]*(?:\([^)]*\))?)\s*·\s*\[sub-plan\]\(([^)]+)\)/g;
  const baseOf = (status: string): string => {
    const m = status.match(/^(TODO|IN PROGRESS|DONE|BLOCKED)\b/);
    return m?.[1] ?? status.trim();
  };
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(roadmapMarkdown))) {
    const roadmapStatus = (match[1] ?? '').trim();
    const subplanFile = (match[2] ?? '').trim();
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

function parseStatusHeader(markdown: string): string | null {
  const match = markdown.match(/\*\*Status:\*\*\s*([^\n·]+)/);
  return match?.[1]?.trim() ?? null;
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

    const phaseFiles = entries.filter((name) => /^phase-.*\.md$/.test(name));
    const subplanStatuses: Record<string, string | null> = {};
    for (const name of phaseFiles) {
      const phasePath = join(workspaceDir, name);
      const markdown = readFileSync(phasePath, 'utf8');
      const relFile = relative(root, phasePath);
      report.findings.push(...checkSliceStatuses(relFile, markdown).findings);
      subplanStatuses[name] = parseStatusHeader(markdown);
    }

    const roadmapPath = join(workspaceDir, 'ROADMAP.md');
    if (existsSync(roadmapPath)) {
      const roadmapMarkdown = readFileSync(roadmapPath, 'utf8');
      const relFile = relative(root, roadmapPath);
      report.findings.push(
        ...checkRoadmapSync(relFile, roadmapMarkdown, subplanStatuses).findings,
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
