#!/usr/bin/env node
/**
 * Mechanical reads for closing out a `.claude/plans/<slug>/` workspace.
 *
 * Usage: closeout.mjs checklist <workspace-dir>
 *        closeout.mjs closes <workspace-dir>
 *        closeout.mjs sources <markdown-file>
 *
 * `checklist` prints one verification checklist per phase: the Objective's done clause, then
 * every step's `Acceptance:` clause. `closes` prints `Closes #N` for each issue a finished
 * phase lists in its `**Closes:**` header line. `sources` checks that every backticked path on a
 * `Source:` line exists, resolved from the file's own directory.
 *
 * Exit 0 is clean, 1 has findings, 2 is a usage error.
 *
 * Not checked by this checker: whether a done clause is actually met, or whether an issue a
 * phase lists is the right one to close. Those stay with the model reading the plan.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface RunResult {
  status: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

interface RoadmapPhase {
  number: string;
  name: string;
  status: string;
  file: string;
}

const USAGE = [
  'usage: closeout.mjs checklist <workspace-dir>',
  '       closeout.mjs closes <workspace-dir>',
  '       closeout.mjs sources <markdown-file>',
].join('\n');

const PHASE_LINE =
  /^- \[[ xX]\] \*\*Phase (\d+): (.+?)\*\* · Status: (.+?) · \[[^\]]*\]\(([^)]+)\)/;
const CLOSES_LINE = /^\*\*Closes:\*\*(.*)$/;
const CLOSES_VALUE = /^#\d+(?:\s*,\s*#\d+)*$/;

/** Reads each phase line of a ROADMAP, in order. */
function parseRoadmap(markdown: string): RoadmapPhase[] {
  const phases: RoadmapPhase[] = [];
  for (const line of markdown.split('\n')) {
    const match = PHASE_LINE.exec(line);
    if (!match) continue;
    phases.push({
      number: match[1] ?? '',
      name: match[2] ?? '',
      status: (match[3] ?? '').trim(),
      file: match[4] ?? '',
    });
  }
  return phases;
}

/** The lines of a `## <heading>` section, up to the next `## ` heading. */
function sectionLines(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    out.push(line);
  }
  return out;
}

const collapse = (lines: string[]): string =>
  lines
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');

/** From "Done when" to the end of the Objective paragraph that holds it, or null. */
function doneClause(markdown: string): string | null {
  const lines = sectionLines(markdown, 'Objective');
  let paragraph: string[] = [];
  const paragraphs: string[][] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (paragraph.length > 0) paragraphs.push(paragraph);
      paragraph = [];
    } else {
      paragraph.push(line);
    }
  }
  if (paragraph.length > 0) paragraphs.push(paragraph);
  for (const lines of paragraphs) {
    const text = collapse(lines);
    const at = text.indexOf('Done when');
    if (at !== -1) return text.slice(at);
  }
  return null;
}

const BULLET_PREFIX = '- ';
const ACCEPTANCE_MARKER = 'Acceptance:';

/** The `## Steps` bullet items, each as its lines with wrapped continuations kept. */
function stepItems(markdown: string): string[][] {
  const items: string[][] = [];
  for (const line of sectionLines(markdown, 'Steps')) {
    const current = items.at(-1);
    if (line.startsWith(BULLET_PREFIX)) {
      items.push([line.slice(BULLET_PREFIX.length)]);
    } else if (current && /^\s+\S/.test(line)) {
      current.push(line);
    } else if (current && current.at(-1) !== '') {
      // A blank line or an unindented line ends the item's continuation.
      current.push('');
    }
  }
  return items;
}

/** Each `Acceptance:` clause in one step's text, up to the next marker or the end. */
function clausesOf(text: string): string[] {
  // A marker inside a backticked span is prose naming the word, not a clause.
  const marks: number[] = [];
  for (const match of text.matchAll(new RegExp(ACCEPTANCE_MARKER, 'g'))) {
    const backticksBefore = text.slice(0, match.index).split('`').length - 1;
    if (backticksBefore % 2 === 0) marks.push(match.index);
  }
  return marks
    .map((at, index) =>
      text
        .slice(at + ACCEPTANCE_MARKER.length, marks[index + 1] ?? text.length)
        .trim(),
    )
    .filter((clause) => clause !== '');
}

/** Every `Acceptance:` clause in the `## Steps` items, wrapped lines joined. */
function acceptanceClauses(markdown: string): string[] {
  return stepItems(markdown).flatMap((item) => clausesOf(collapse(item)));
}

function readPhases(dir: string): RoadmapPhase[] {
  return parseRoadmap(readFileSync(join(dir, 'ROADMAP.md'), 'utf8'));
}

function checklist(dir: string): RunResult {
  const out: string[] = [];
  for (const phase of readPhases(dir)) {
    if (out.length > 0) out.push('');
    out.push(`## Phase ${phase.number}: ${phase.name}`);
    const path = join(dir, phase.file);
    if (!existsSync(path)) continue;
    const markdown = readFileSync(path, 'utf8');
    const done = doneClause(markdown);
    if (done) out.push(`- [ ] ${done}`);
    for (const clause of acceptanceClauses(markdown)) {
      out.push(`- [ ] ${clause}`);
    }
  }
  return { status: 0, stdout: `${out.join('\n')}\n`, stderr: '' };
}

/** The issues not yet in `seen`, in order and without repeats, each added to `seen` as it is returned. */
function firstSeen(issues: string[], seen: Set<string>): string[] {
  const fresh: string[] = [];
  for (const issue of issues) {
    if (seen.has(issue)) continue;
    seen.add(issue);
    fresh.push(issue);
  }
  return fresh;
}

function closes(dir: string): RunResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const seen = new Set<string>();
  let findings = 0;
  for (const phase of readPhases(dir)) {
    const path = join(dir, phase.file);
    if (!existsSync(path)) {
      stderr.push(`${phase.file}: sub-plan does not exist`);
      findings += 1;
      continue;
    }
    const lines = readFileSync(path, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      const match = CLOSES_LINE.exec(line);
      if (!match) continue;
      const value = (match[1] ?? '').trim();
      if (!CLOSES_VALUE.test(value)) {
        stderr.push(
          `${phase.file}:${index + 1}: malformed **Closes:** line, expected "#N, #M" (got "${value}")`,
        );
        findings += 1;
        continue;
      }
      const issues = value.split(',').map((issue) => issue.trim());
      if (phase.status.startsWith('DONE')) {
        const fresh = firstSeen(issues, seen);
        stdout.push(...fresh.map((issue) => `Closes ${issue}`));
      } else {
        stderr.push(
          ...issues.map(
            (issue) =>
              `Phase ${phase.number} (${phase.status}) lists ${issue}, which stays open until the phase is DONE`,
          ),
        );
        findings += issues.length;
      }
    }
  }
  return {
    status: findings > 0 ? 1 : 0,
    stdout: stdout.length > 0 ? `${stdout.join('\n')}\n` : '',
    stderr: stderr.length > 0 ? `${stderr.join('\n')}\n` : '',
  };
}

function sources(file: string): RunResult {
  const base = dirname(file);
  const findings: string[] = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('Source:')) continue;
    const paths = [...line.matchAll(/`([^`]+)`/g)].map(
      (match) => match[1] ?? '',
    );
    if (paths.length === 0) {
      findings.push(
        `${file}:${index + 1}: Source line names no backticked path`,
      );
      continue;
    }
    for (const path of paths) {
      if (!existsSync(resolve(base, path))) {
        findings.push(`${file}:${index + 1}: ${path} does not exist`);
      }
    }
  }
  return {
    status: findings.length > 0 ? 1 : 0,
    stdout: findings.length > 0 ? `${findings.join('\n')}\n` : '',
    stderr: '',
  };
}

const usageError = (message: string): RunResult => ({
  status: 2,
  stdout: '',
  stderr: `${message}\n${USAGE}\n`,
});

/** Runs the CLI over `argv` (subcommand first) and returns what it would print. */
function run(argv: string[]): RunResult {
  const [command, target] = argv;
  if (!command) return usageError('closeout: missing subcommand');
  if (
    command !== 'checklist' &&
    command !== 'closes' &&
    command !== 'sources'
  ) {
    return usageError(`closeout: unknown subcommand "${command}"`);
  }
  if (!target) return usageError(`closeout ${command}: missing argument`);
  const isDir = command !== 'sources';
  if (!existsSync(target)) {
    return usageError(`closeout ${command}: ${target} does not exist`);
  }
  const kind = statSync(target);
  if (isDir && !kind.isDirectory()) {
    return usageError(`closeout ${command}: ${target} is not a directory`);
  }
  if (!isDir && !kind.isFile()) {
    return usageError(`closeout ${command}: ${target} is not a file`);
  }
  if (isDir && !existsSync(join(target, 'ROADMAP.md'))) {
    return usageError(`closeout ${command}: ${target} has no ROADMAP.md`);
  }
  if (command === 'checklist') return checklist(target);
  if (command === 'closes') return closes(target);
  return sources(target);
}

function main(): void {
  const result = run(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
