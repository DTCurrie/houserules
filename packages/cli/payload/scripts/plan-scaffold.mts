#!/usr/bin/env node
/**
 * Creates a `.claude/plans/<slug>/` workspace: `PLAN.md`, `ROADMAP.md`, and one
 * `phase-N-<phase-slug>.md` per phase, every status `TODO`.
 *
 * Usage:
 *   plan-scaffold.mjs <slug> --phases <a,b,c> [--date YYYY-MM-DD]
 *
 * The workspace is created relative to the current directory. `--date` defaults to the local
 * date. Prose sections keep the template's `<...>` placeholders for the planner to fill. Each
 * written path prints on its own line and the exit code is 0. An existing
 * `.claude/plans/<slug>` (file or directory) exits 1 with one message naming it. An unknown
 * flag, a missing slug or `--phases`, a bad date, a slug that is not kebab-case (a `/` included),
 * or a duplicate phase slug exits 2. Every refusal writes nothing.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE =
  'usage: plan-scaffold.mjs <slug> --phases <a,b,c> [--date YYYY-MM-DD]';
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class UsageError extends Error {}

interface ScaffoldInput {
  slug: string;
  phases: string[];
  date: string;
}

function localToday(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function requireKebab(kind: string, value: string): void {
  if (!KEBAB.test(value)) {
    throw new UsageError(`${kind} "${value}" is not kebab-case`);
  }
}

function parseArgs(argv: string[]): ScaffoldInput {
  let slug: string | undefined;
  let phasesArg: string | undefined;
  let date: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === '--phases' || arg === '--date') {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      index += 1;
      if (arg === '--phases') phasesArg = value;
      else date = value;
    } else if (arg.startsWith('--')) {
      throw new UsageError(`unknown flag ${arg}`);
    } else if (slug === undefined) {
      slug = arg;
    } else {
      throw new UsageError(`unexpected argument "${arg}"`);
    }
  }
  if (slug === undefined) throw new UsageError('missing <slug>');
  if (phasesArg === undefined) throw new UsageError('missing --phases');
  return validateInput(slug, phasesArg, date);
}

function validateInput(
  slug: string,
  phasesArg: string,
  date: string | undefined,
): ScaffoldInput {
  requireKebab('slug', slug);
  const phases = phasesArg.split(',');
  for (const phase of phases) requireKebab('phase slug', phase);
  const duplicate = phases.find((phase, i) => phases.indexOf(phase) !== i);
  if (duplicate !== undefined) {
    throw new UsageError(`duplicate phase slug "${duplicate}"`);
  }
  const resolvedDate = date ?? localToday();
  if (!DATE.test(resolvedDate)) {
    throw new UsageError(`date "${resolvedDate}" is not YYYY-MM-DD`);
  }
  return { slug, phases, date: resolvedDate };
}

const phaseFile = (number: number, phase: string): string =>
  `phase-${number}-${phase}.md`;

function planDoc({ slug, phases, date }: ScaffoldInput): string {
  const list = phases
    .map(
      (phase, i) =>
        `${i + 1}. **${phase}**: <one line> → [${phaseFile(i + 1, phase)}](${phaseFile(i + 1, phase)})`,
    )
    .join('\n');
  return `# PLAN: ${slug}

**Created:** ${date} · **Status:** see [ROADMAP.md](ROADMAP.md)

## Goal

<One paragraph: what we're building and why. The problem, not the steps.>

## Approach

<The high-level strategy: key decisions, constraints, explicit non-goals.>

## Phases

${list}

## Key files & interfaces

<The load-bearing files/APIs this work touches, and where a resuming session should look first.>
`;
}

function roadmapDoc({ slug, phases, date }: ScaffoldInput): string {
  const lines = phases
    .map(
      (phase, i) =>
        `- [ ] **Phase ${i + 1}: ${phase}** · Status: TODO · [sub-plan](${phaseFile(i + 1, phase)})`,
    )
    .join('\n');
  return `# ROADMAP: ${slug}

**Status:** TODO · **Started:** ${date} · **Updated:** ${date}

> Resuming? Read this file's status lines below. Do not re-derive scope from the transcript.

## Phases

${lines}

## Log

- ${date}: scaffolded.
`;
}

function subplanDoc(number: number, phase: string): string {
  return `# Phase ${number}: ${phase}

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)

## Objective

<What "done" means here: the falsifiable acceptance from step 2.>

## Reference

<Relative links to any spec, format, or standard this phase's work must conform to, or "none".>

## Standing rulings

none

## Steps

- [ ] <step: the decision made, plus the acceptance that shows it holds. Never a code block>
- [ ] <step>

## Notes & decisions

<A log of how a decision was reached: what you weighed, what you ruled out, surprises. The decision
itself lands in \`## Steps\` or \`## Standing rulings\`.>
`;
}

function main(argv: string[]): number {
  let input: ScaffoldInput;
  try {
    input = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`plan-scaffold: ${error.message}\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  const dir = join('.claude', 'plans', input.slug);
  if (existsSync(dir)) {
    process.stderr.write(`plan-scaffold: ${dir} already exists\n`);
    return EXIT_FAILURE;
  }
  const files: [string, string][] = [
    [join(dir, 'PLAN.md'), planDoc(input)],
    [join(dir, 'ROADMAP.md'), roadmapDoc(input)],
    ...input.phases.map((phase, i): [string, string] => [
      join(dir, phaseFile(i + 1, phase)),
      subplanDoc(i + 1, phase),
    ]),
  ];
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of files) {
    writeFileSync(path, content);
    process.stdout.write(`${path}\n`);
  }
  return EXIT_SUCCESS;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  process.exit(main(process.argv.slice(2)));
}
