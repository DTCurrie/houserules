/**
 * Checks a drafted PR description against the mechanical and hybrid clauses of
 * `skills/pr-description/SKILL.md`.
 *
 * The description never lands in a repo file, so this reads the drafted text from stdin
 * rather than a `files` argv list, and every finding's `file` is the constant
 * `'pr-description'` rather than a real path. Structural checks (headings, section order,
 * banned phrases, changelog-shaped bullets) read the body once it is unwrapped from its
 * outer fence. `verify-commands` and `layer-heading` need repo context a bare string cannot
 * carry, so those two take it in as a parameter, per the `readGateInputs` pattern: a pure
 * checker should not reach for config itself.
 */
import { execSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { loadConfigSafe } from '@houserules/payload/config';
import {
  emptyReport,
  exitCodeFor,
  renderReport,
  type Finding,
} from '@houserules/payload/findings';

const FILE = 'pr-description';

const DECLINED = [
  '"Do not write from memory of the session" — no way to observe what produced the text',
  '"Create or update the PR yourself only when asked" — reading user intent is not checkable',
  '"Name the user-facing capability, not the implementation" — a concreteness judgment',
  '"Include this only when the PR makes a decision a reviewer would question", and the ' +
    'inverse "skip when every decision is obvious" — a reviewer\'s judgment call',
  '"Present tense for behavior. First person for rationale." — tense and person detection ' +
    'over free text, no NLP dependency ships in the payload',
  '"Name both the old and the new name when renaming or deprecating" — needs the diff\'s meaning',
];

/**
 * The repo's default branch, for `pr-description`'s "Default `<base>` to the repo's main
 * branch when the argument is absent." Prefers the remote's HEAD, then falls back to
 * whichever of `main`/`master` exists locally, then `main` itself.
 */
export function resolveDefaultBase(cwd: string = process.cwd()): string {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    const branch = ref.split('/').pop();
    if (branch) return branch;
  } catch {
    // no origin remote, or no symbolic HEAD set on it
  }
  for (const candidate of ['main', 'master']) {
    try {
      execSync(`git rev-parse --verify ${candidate}`, {
        cwd,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return candidate;
    } catch {
      // candidate branch does not exist locally
    }
  }
  return 'main';
}

interface FenceResult {
  body: string;
  findings: Finding[];
}

/**
 * Unwraps the outer fenced code block a drafted description should arrive in. Returns the
 * unwrapped body and any wrapper findings: missing entirely, or an outer fence too short to
 * contain a nested one.
 */
export function extractFence(output: string): FenceResult {
  const trimmed = output.trim();
  const match = trimmed.match(/^(`{3,})\n([\s\S]*)\n\1\s*$/);
  if (!match) {
    return {
      body: trimmed,
      findings: [
        {
          rule: 'pr-description/fenced-wrapper',
          level: 'error',
          file: FILE,
          line: null,
          msg: 'The description is not returned inside a fenced code block.',
        },
      ],
    };
  }
  const [, fence, inner] = match;
  const findings: Finding[] = [];
  if (/^ {0,3}`{3,}/m.test(inner!) && fence!.length < 4) {
    findings.push({
      rule: 'pr-description/fenced-wrapper',
      level: 'error',
      file: FILE,
      line: null,
      msg: 'The description contains a nested fenced code block. Use four or more backticks for the outer fence.',
    });
  }
  return { body: inner!, findings };
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * `## Summary`/`## Description` wrapper headings, non-`###` section headings, a Testing
 * section that is not last, and (as a candidate, not a verdict) an opening paragraph over
 * two sentences.
 */
export function checkStructure(body: string): Finding[] {
  const findings: Finding[] = [];
  const lines = body.split('\n');
  const headings: { line: number; level: number; text: string }[] = [];

  lines.forEach((line, index) => {
    const match = line.match(HEADING_RE);
    if (!match) return;
    headings.push({
      line: index + 1,
      level: match[1]!.length,
      text: match[2]!.trim(),
    });
  });

  for (const heading of headings) {
    if (heading.level === 2 && /^(summary|description)$/i.test(heading.text)) {
      findings.push({
        rule: 'pr-description/no-wrapper-heading',
        level: 'error',
        file: FILE,
        line: heading.line,
        msg: `Drop the "${heading.text}" wrapper heading. The opening paragraph stands on its own.`,
      });
      continue;
    }
    if (heading.level !== 3) {
      findings.push({
        rule: 'pr-description/heading-level',
        level: 'error',
        file: FILE,
        line: heading.line,
        msg: `"${heading.text}" uses ${'#'.repeat(heading.level)}. Every section heading is ###.`,
      });
    }
  }

  const sectionHeadings = headings.filter((h) => h.level === 3);
  const testingIndex = sectionHeadings.findIndex((h) =>
    /^testing$/i.test(h.text),
  );
  if (testingIndex !== -1 && testingIndex !== sectionHeadings.length - 1) {
    findings.push({
      rule: 'pr-description/testing-not-last',
      level: 'error',
      file: FILE,
      line: sectionHeadings[testingIndex]!.line,
      msg: 'Testing is not the last section. It always comes last.',
    });
  }

  const firstHeadingLine = headings[0]?.line ?? lines.length + 1;
  const opening = lines
    .slice(0, firstHeadingLine - 1)
    .join(' ')
    .trim();
  if (opening.length > 0) {
    const sentenceCount = (opening.match(/[.!?](?:\s|$)/g) ?? []).length;
    if (sentenceCount > 2) {
      findings.push({
        rule: 'pr-description/opening-length',
        level: 'warn',
        file: FILE,
        line: 1,
        msg: `Opening paragraph reads as ${sentenceCount} sentences. One or two on what changed and why.`,
      });
    }
  }

  return findings;
}

const BANNED_PHRASES = ['updated the package', 'tests pass'];

/** "Never 'updated the package'" and "'Tests pass' is not enough", as literal phrase matches. */
export function checkBannedPhrases(body: string): Finding[] {
  const findings: Finding[] = [];
  const lines = body.split('\n');
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    for (const phrase of BANNED_PHRASES) {
      if (lower.includes(phrase)) {
        findings.push({
          rule: 'pr-description/banned-phrase',
          level: 'error',
          file: FILE,
          line: index + 1,
          msg: `Banned phrase "${phrase}". Name the symbol that changed, or the exact command run.`,
        });
      }
    }
  });
  return findings;
}

const CHANGELOG_HEADING_RE = /^#{1,6}\s*(changelog|files changed)\s*$/i;
const DIFFSTAT_LINE_RE = /\|\s*\d+\s*[+-]+\s*$/;
const DIFFSTAT_SUMMARY_RE = /^\s*\d+ files? changed\b/i;

/** A candidate finder for "No auto-generated changelogs, file lists, or diff stats." */
export function checkChangelogPattern(body: string): Finding[] {
  const findings: Finding[] = [];
  body.split('\n').forEach((line, index) => {
    const isChangelogHeading = CHANGELOG_HEADING_RE.test(line.trim());
    const isDiffstatLine =
      DIFFSTAT_LINE_RE.test(line) || DIFFSTAT_SUMMARY_RE.test(line);
    if (!isChangelogHeading && !isDiffstatLine) return;
    findings.push({
      rule: 'pr-description/changelog-pattern-candidate',
      level: 'warn',
      file: FILE,
      line: index + 1,
      msg: 'Reads like an auto-generated changelog, file list, or diff-stat dump. Confirm it is a genuine layer section.',
    });
  });
  return findings;
}

function testingSectionText(body: string): string | null {
  const lines = body.split('\n');
  const startIndex = lines.findIndex((line) =>
    /^###\s+testing\s*$/i.test(line.trim()),
  );
  if (startIndex === -1) return null;
  const rest = lines.slice(startIndex + 1);
  const endIndex = rest.findIndex((line) => HEADING_RE.test(line));
  return (endIndex === -1 ? rest : rest.slice(0, endIndex)).join('\n');
}

/** "Use this repo's own verify commands." Errors when Testing quotes none of them. */
export function checkVerifyCommands(
  body: string,
  verifyCommands: string[],
): Finding[] {
  const testing = testingSectionText(body);
  if (testing === null) return [];
  const quotesOne = verifyCommands.some((command) => testing.includes(command));
  if (quotesOne) return [];
  return [
    {
      rule: 'pr-description/verify-commands-missing',
      level: 'error',
      file: FILE,
      line: null,
      msg: `Testing section quotes none of this repo's verify commands (${verifyCommands.join(', ')}).`,
    },
  ];
}

const NON_LAYER_HEADINGS = new Set(['why?', 'why', 'testing']);

/**
 * "Use the architecture layers this repo actually has... Do not import a layer vocabulary
 * from another repo." A candidate finder: flags an `###` section heading that names none of
 * the configured targets.
 */
export function checkLayerHeadings(body: string, targets: string[]): Finding[] {
  const findings: Finding[] = [];
  const normalizedTargets = targets.map((t) => t.toLowerCase());
  body.split('\n').forEach((line, index) => {
    const match = line.match(HEADING_RE);
    if (!match || match[1]!.length !== 3) return;
    const text = match[2]!.trim();
    const lower = text.toLowerCase();
    if (NON_LAYER_HEADINGS.has(lower)) return;
    const recognized = normalizedTargets.some(
      (t) => lower.includes(t) || t.includes(lower),
    );
    if (recognized) return;
    findings.push({
      rule: 'pr-description/unrecognized-layer-heading',
      level: 'warn',
      file: FILE,
      line: index + 1,
      msg: `"${text}" matches none of this repo's configured targets. Confirm it names a real layer.`,
    });
  });
  return findings;
}

function main(): void {
  const output = readFileSync(0, 'utf8');
  const config = loadConfigSafe();
  const report = emptyReport();
  report.declined.push(...DECLINED);

  const { body, findings: fenceFindings } = extractFence(output);
  report.findings.push(...fenceFindings);
  report.findings.push(...checkStructure(body));
  report.findings.push(...checkBannedPhrases(body));
  report.findings.push(...checkChangelogPattern(body));

  const verifyCommands = [
    ...(config.verify?.commands ?? []),
    ...config.targets.flatMap((t) => t.verifyCommands ?? []),
  ];
  if (verifyCommands.length > 0) {
    report.findings.push(...checkVerifyCommands(body, verifyCommands));
  } else {
    report.declined.push(
      'verify-commands-missing: no verifyCommands configured in houserules.config.json',
    );
  }

  const targets = config.targets.map((t) => t.label ?? t.name);
  if (targets.length > 0) {
    report.findings.push(...checkLayerHeadings(body, targets));
  } else {
    report.declined.push(
      'unrecognized-layer-heading: no targets configured in houserules.config.json',
    );
  }

  process.stdout.write(`${renderReport(report)}\n`);
  process.exit(exitCodeFor(report));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  if (process.argv[2] === 'base') {
    process.stdout.write(`${resolveDefaultBase()}\n`);
  } else {
    main();
  }
}
