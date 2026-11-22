import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { HouseError } from '../../house-error.js';
import type { BashWallReport } from './bash-wall.js';
import { STOP_TOTAL_LABEL } from './hook-health.js';
import type { FixConfigSummary, ReportDocument } from './report-document.js';

const SUBCOMMAND_TOOLS = new Set(['git', 'gh']);
const MODULE_SIGNATURE = /^Cannot find module '([^']+)'$/;
const SCRIPT_SIGNATURE = /^missing script: (.+)$/;
const REDACTED_SIGNATURE = 'stderr line (redacted)';
// A leading `NAME=value` pair, whose value is often a path.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;
const ASSIGNMENT_ONLY = '(assignment)';
const EMPTY_COMMAND = '(empty)';

// Shell punctuation that can precede the executable: subshell and group openers, quotes.
function bareToken(token: string): string {
  return token.replace(/^[({'"`]+/, '').replace(/['"`]+$/, '');
}

// A token with a slash is a path, which may name a machine, a user, or a repo. Keep what it
// ran, which is the basename, never where it lived.
function nameOf(token: string): string {
  const bare = bareToken(token);
  return bare.includes('/') ? basename(bare) : bare;
}

// A leading assignment, or bare punctuation such as a lone `(` or `{`, precedes the executable.
function isPrefixToken(token: string): boolean {
  return ENV_ASSIGNMENT.test(token) || bareToken(token) === '';
}

function commandFamily(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return EMPTY_COMMAND;
  let index = 0;
  while (index < tokens.length && isPrefixToken(tokens[index] ?? ''))
    index += 1;
  const first = tokens[index];
  if (first === undefined) return ASSIGNMENT_ONLY;
  const name = nameOf(first);
  const second = tokens[index + 1];
  if (second !== undefined && SUBCOMMAND_TOOLS.has(name))
    return `${name} ${nameOf(second)}`;
  return name;
}

const REASON_REDACTED = '(reason redacted)';
const READ_GUARD_PREFIX = 'houserules read guard: ';
const READ_GUARD_ADVICE = (path: string): string =>
  `. Don't read it whole — grep for what you need (\`grep -n '<pattern>' ${path}\`) then Read with offset+limit, or re-run this Read with an explicit limit if you truly need a window.`;
const READ_GUARD_DENYLISTED = 'matches a generated/denylisted pattern';
const READ_GUARD_REASON = new RegExp(
  `^${escapeRegExp(READ_GUARD_PREFIX)}(.+?) (${escapeRegExp(READ_GUARD_DENYLISTED)} \\(.+?\\)|is large \\(\\d+ KB > \\d+ KB\\))${escapeRegExp(READ_GUARD_ADVICE('\u0000')).replace('\u0000', '(.+?)')}$`,
);
const LEDGER_GATE_REASON =
  /^(Blocked by houserules subagent write gate: a subagent may not run ledger command )`.+`(\. Describe the issue and let the caller act on it\.)$/;
const CUSTOM_RULE_REASON =
  /^(Blocked by houserules\.config\.json guard rule: ).+$/;
const FIXED_REASONS = new Set([
  "git commit is the user's to run. Describe what's staged and stop.",
  "git push is the user's to run.",
  'git stash dumps the full untracked-file list into context. Use `git diff --name-only`, `git show HEAD:<path>`, or inspect the one file you changed.',
  'git checkout/restore/reset --hard/clean/switch -f discard uncommitted work, and a file reverted to HEAD loses every uncommitted edit in it, not only yours. Undo your own edit by applying its inverse with Edit. Switch branches with `git switch`. List untracked files with `git status --short`.',
  "Opening PRs/issues is the user's call. Describe what's ready and stop.",
  'Blocked by houserules subagent write gate: a subagent may not author a changeset. Changesets are one per feature, not one per incremental change. Describe the change and let the caller record it.',
  'Blocked by houserules subagent write gate: a subagent may not edit a ledger or changeset file directly.',
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The read guard's message with the blocked path and the matched glob masked. Sizes are kept. */
function redactReadGuardReason(why: string): string {
  const maskedWhy = why.startsWith(READ_GUARD_DENYLISTED)
    ? `${READ_GUARD_DENYLISTED} (<pattern>)`
    : why;
  return `${READ_GUARD_PREFIX}<path> ${maskedWhy}${READ_GUARD_ADVICE('<path>')}`;
}

/**
 * Masks the interpolated parts of a guard reason: paths and globs from the read guard, the
 * ledger subcommand from the write gate, the pattern of a config rule. Messages that interpolate
 * nothing pass through. A reason matching no known message shape becomes a placeholder, since an
 * unknown string may carry private input.
 */
function redactReason(reason: string): string {
  const read = READ_GUARD_REASON.exec(reason);
  if (read) return redactReadGuardReason(read[2] ?? '');
  const ledger = LEDGER_GATE_REASON.exec(reason);
  if (ledger) return `${ledger[1]}\`<subcommand>\`${ledger[2]}`;
  const custom = CUSTOM_RULE_REASON.exec(reason);
  if (custom) return `${custom[1]}<pattern>`;
  if (FIXED_REASONS.has(reason)) return reason;
  return REASON_REDACTED;
}

function redactSignature(signature: string): string {
  const module = MODULE_SIGNATURE.exec(signature);
  if (module) return `Cannot find module '${basename(module[1] ?? '')}'`;
  const script = SCRIPT_SIGNATURE.exec(signature);
  if (script) return `missing script: ${basename(script[1] ?? '')}`;
  return REDACTED_SIGNATURE;
}

function redactSignatures(
  signatures: { signature: string; count: number }[],
): { signature: string; count: number }[] {
  const merged = new Map<string, number>();
  for (const { signature, count } of signatures) {
    const redacted = redactSignature(signature);
    merged.set(redacted, (merged.get(redacted) ?? 0) + count);
  }
  return [...merged].map(([signature, count]) => ({ signature, count }));
}

const BARE_SCRIPT_NAME = /^[\w-]+\.(?:mjs|cjs|js)$/;
const PRE_TOOL_USE_LABEL = /^PreToolUse:[\w-]+$/;
// A hook that maps to no script keeps its raw command as its name, and a command can carry a
// path or an argument. A bare script basename, the per-Stop total row, and a
// `PreToolUse:<tool>` label are safe.
function redactHookName(name: string): string {
  if (
    BARE_SCRIPT_NAME.test(name) ||
    name === STOP_TOTAL_LABEL ||
    PRE_TOOL_USE_LABEL.test(name)
  )
    return name;
  return commandFamily(name);
}

function redactStopHooks(
  stopHooks: NonNullable<ReportDocument['hooks']['stopHooks']>,
): NonNullable<ReportDocument['hooks']['stopHooks']> {
  // Two raw commands can reduce to one family and stay two rows, since percentiles do not add.
  return stopHooks.map((row) => ({
    ...row,
    hook: redactHookName(row.hook),
  }));
}

/** Rebuilds the fix block from its named fields only, so a stray key never leaves the export. */
/** Keeps the slowest calls' timing and cuts each command to its family. */
function maskBashWall(bashWall: BashWallReport): BashWallReport {
  return {
    ...bashWall,
    slowest: bashWall.slowest.map((call) => ({
      ...call,
      command: commandFamily(call.command),
    })),
  };
}

function maskFix(fix: FixConfigSummary): FixConfigSummary {
  return {
    runsAtRoot: fix.runsAtRoot === true,
    commandCount: Number(fix.commandCount),
    hasFilterFlag: fix.hasFilterFlag === true,
    passPaths: fix.passPaths === true,
    targetsWithFixCommands: Number(fix.targetsWithFixCommands),
  };
}

/**
 * Returns a copy with every command reduced to its family, every crash signature reduced
 * to a module basename or a fixed placeholder, and every Stop hook name that is not a bare
 * script name reduced to its command family. The input is not mutated.
 */
export function redactDocument(document: ReportDocument): ReportDocument {
  const { stopHooks } = document.hooks;
  const { fix, bashWall, ...rest } = document;
  return {
    ...rest,
    ...(fix ? { fix: maskFix(fix) } : {}),
    ...(bashWall ? { bashWall: maskBashWall(bashWall) } : {}),
    hooks: {
      ...document.hooks,
      crashSignatures: redactSignatures(document.hooks.crashSignatures),
      ...(stopHooks ? { stopHooks: redactStopHooks(stopHooks) } : {}),
    },
    guard: document.guard.map(({ reason, guard, ...block }) => ({
      ...block,
      ...(reason === undefined ? {} : { reason: redactReason(reason) }),
      blockedCommand: commandFamily(block.blockedCommand),
      ...(guard === undefined ? {} : { guard: redactHookName(guard) }),
    })),
    friction: {
      ...document.friction,
      denials: document.friction.denials.map((denial) => ({
        ...denial,
        command: commandFamily(denial.command),
      })),
      retryRuns: document.friction.retryRuns.map((run) => ({
        ...run,
        command: commandFamily(run.command),
      })),
    },
  };
}

/** Writes the document as pretty JSON, creating parent directories. */
export function writeExportFile(path: string, document: ReportDocument): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
}

function isReportDocument(value: unknown): value is ReportDocument {
  if (typeof value !== 'object' || value === null) return false;
  const { meta, tokens } = value as { meta?: unknown; tokens?: unknown };
  if (typeof meta !== 'object' || meta === null) return false;
  const { label, generatedAt } = meta as Record<string, unknown>;
  if (typeof label !== 'string' || typeof generatedAt !== 'string')
    return false;
  if (typeof tokens !== 'object' || tokens === null) return false;
  const { totals } = tokens as { totals?: unknown };
  return typeof totals === 'object' && totals !== null;
}

function readImportFile(path: string): ReportDocument {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new HouseError(
      `Cannot read ${path}: the file is missing or unreadable.`,
      { cause },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new HouseError(`Cannot import ${path}: the file is not valid JSON.`, {
      cause,
    });
  }
  if (!isReportDocument(parsed))
    throw new HouseError(
      `Cannot import ${path}: the file is not a houserules report export.`,
    );
  return parsed;
}

/** Reads and validates each file in order. Throws `HouseError` naming the first bad path. */
export function readImportFiles(paths: string[]): ReportDocument[] {
  return paths.map(readImportFile);
}
