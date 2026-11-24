import { renderTable } from './render-table.js';

/** One Bash `tool_use` and, when one arrived, its `tool_result`. */
export interface BashCall {
  /** The `tool_use` block's id. */
  id: string;
  /** `input.command`, verbatim. */
  command: string;
  /** {@link bashFamily} of `command`. */
  family: string;
  /** Epoch ms of the record carrying the `tool_use`, or null when it has no parseable timestamp. */
  startMs: number | null;
  /** Epoch ms of the record carrying the matching `tool_result`, or null when none arrived. */
  endMs: number | null;
  /** `(endMs - startMs) / 1000` to 3 decimals. Null when background, unanswered, or unstamped. */
  seconds: number | null;
  /** `input.run_in_background === true`. */
  isBackground: boolean;
  /** The call ran in a subagent transcript, from the caller's option. */
  isSubagent: boolean;
}

/** A call tagged with the session it belongs to, a subagent's call under its parent session. */
export interface SessionBashCall extends BashCall {
  session: string;
}

/** Feeds a transcript's parsed records one at a time, in file order. */
export interface BashCallCollector {
  add(record: unknown): void;
  /** Every Bash call seen, in `tool_use` order, answered or not. */
  finish(): BashCall[];
}

export interface BashCallOptions {
  isSubagent: boolean;
}

/** One family's timed calls. Background, unanswered, and unstamped calls are not in it. */
interface FamilyWall {
  family: string;
  /** Timed calls, the ones with non-null `seconds`. */
  calls: number;
  /** Timed calls that ran in a subagent. */
  subagentCalls: number;
  /** Timed calls whose first real command is a package runner with no scope flag, see {@link isUnscopedRunnerCall}. */
  unscopedCalls: number;
  /** Sum of `seconds`, to 3 decimals. */
  seconds: number;
  /** Mean of the two middle values when `calls` is even. */
  medianSeconds: number;
  /** Nearest rank: the value at sorted index `ceil(0.9 * calls) - 1`. */
  p90Seconds: number;
}

interface SlowCall {
  family: string;
  /** The command, cut to {@link SLOW_COMMAND_MAX_CHARS} characters. */
  command: string;
  seconds: number;
  session: string;
  /** ISO timestamp of the call's start. */
  startedAt: string;
  isSubagent: boolean;
}

export interface BashWallReport {
  /** Every Bash call seen. */
  calls: number;
  /** Calls with non-null `seconds`. */
  timed: number;
  /** Calls kept out of the seconds because they ran in the background. */
  background: number;
  /** Calls kept out because no result arrived or a timestamp was missing. */
  unanswered: number;
  /** Whether any input call came from a subagent transcript. */
  includesSubagents: boolean;
  /** The families with the most total seconds, most first, ties by family name, at most `families`. */
  families: FamilyWall[];
  /** The slowest single timed calls, slowest first, ties by `startedAt`, at most `slowest`. */
  slowest: SlowCall[];
}

export interface SummarizeOptions {
  /** Defaults to {@link TOP_FAMILIES}. */
  families?: number;
  /** Defaults to {@link SLOWEST_CALLS}. */
  slowest?: number;
}

const TOP_FAMILIES = 15;
const SLOWEST_CALLS = 10;
const SLOW_COMMAND_MAX_CHARS = 120;

/**
 * The family a command's wall time counts under. Drop leading env assignments and any
 * `cd <dir> &&`, take the first command of a pipeline or `&&`, `||`, `;` chain, then:
 * `pnpm`, `npm`, `yarn`, `bun`, and `npx` give the manager plus its script or subcommand,
 * with `--filter <x>`, `--filter=<x>`, `-F <x>`, `-C <dir>`, `--dir <dir>`, other flags, and a
 * leading `run` or `exec` dropped, so `pnpm --filter @x/y run test` is `pnpm test`. `node
 * <path>` gives the script's basename, and `node` with no script before its flags end gives
 * `node` plus its first flag, such as `node --test`. `git` and `gh` give the first word plus
 * the subcommand, with `git -C <dir>` dropped. Anything else gives its first word.
 */
export function bashFamily(command: string): string {
  const [first, ...args] = namedCommandWords(command);
  if (first === undefined) return '';
  if (PACKAGE_RUNNERS.has(first)) return runnerFamily(first, args);
  if (first === 'node') return nodeFamily(args);
  if (first === 'git')
    return `git ${subcommandAfter(args, GIT_VALUE_FLAGS)}`.trim();
  if (first === 'gh') return `gh ${subcommandAfter(args, [])}`.trim();
  return first;
}

const LEADING_KEYWORDS = new Set([
  'do',
  'then',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '!',
  '{',
  '(',
]);
const SKIPPED_HEADS = new Set(['for', 'case', 'done', 'fi', 'esac', 'cd']);
const KNOWN_FAMILY_HEADS = new Set([
  'pnpm',
  'npm',
  'yarn',
  'bun',
  'npx',
  'node',
  'git',
  'gh',
]);

/** Marks the `||` between two commands, so the fallback after it can be dropped. */
const FALLBACK_MARKER = '||';

/**
 * The commands a chain runs, in order. Shell keywords before a command, loop and branch
 * headers, `cd`, bare assignments, and the fallback after `||` are not commands.
 */
function chainCommands(command: string): string[][] {
  const commands: string[][] = [];
  let isFallback = false;
  for (const segment of splitChain(command)) {
    if (segment === FALLBACK_MARKER) {
      isFallback = true;
      continue;
    }
    const wasFallback = isFallback;
    isFallback = false;
    const words = segmentWords(segment);
    const [head] = words;
    if (wasFallback || head === undefined || SKIPPED_HEADS.has(head)) continue;
    commands.push(words);
  }
  return commands;
}

function segmentWords(segment: string): string[] {
  const tokens = tokenize(segment);
  let start = 0;
  while (start < tokens.length && LEADING_KEYWORDS.has(tokens[start] ?? ''))
    start += 1;
  return commandWords(tokens.slice(start));
}

/**
 * The words of the command {@link bashFamily} names: the first one whose family is known,
 * else the first command of any kind.
 */
function namedCommandWords(command: string): string[] {
  const commands = chainCommands(command);
  const known = commands.find(([head]) => KNOWN_FAMILY_HEADS.has(head ?? ''));
  return known ?? commands[0] ?? [];
}

/**
 * Whether the command {@link bashFamily} names is a package runner with no scope flag:
 * `--filter`, `-F`, `--dir`, or `-C`, spaced or `=`-joined. A `cd` is not a scope flag.
 * Any other command is not unscoped.
 */
export function isUnscopedRunnerCall(command: string): boolean {
  const [first, ...args] = namedCommandWords(command);
  if (first === undefined || !PACKAGE_RUNNERS.has(first)) return false;
  return !args.some((arg) =>
    RUNNER_VALUE_FLAGS.some(
      (flag) =>
        arg === flag || (flag.startsWith('--') && arg.startsWith(`${flag}=`)),
    ),
  );
}

const PACKAGE_RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun', 'npx']);
const RUNNER_VALUE_FLAGS = ['--filter', '-F', '--dir', '-C'];
const GIT_VALUE_FLAGS = ['-C', '-c', '--git-dir', '--work-tree'];
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECTION = /^\d*[<>]/;
const GROUP_OPENERS = /^[({]+/;

/**
 * The words that name a segment's command: env assignments dropped, a subshell or group opener
 * cut from the head, and an `exec` that only redirects, `exec </dev/null`, read as no command.
 */
function commandWords(tokens: string[]): string[] {
  const [head = '', ...rest] = stripEnvAssignments(tokens);
  const opened = head.replace(GROUP_OPENERS, '');
  const words = opened ? [opened, ...rest] : rest;
  const isRedirectOnlyExec =
    words[0] === 'exec' &&
    words.slice(1).every((word) => REDIRECTION.test(word));
  return isRedirectOnlyExec ? [] : words;
}

function stripEnvAssignments(tokens: string[]): string[] {
  let start = 0;
  while (start < tokens.length && ENV_ASSIGNMENT.test(tokens[start] ?? ''))
    start += 1;
  return tokens.slice(start);
}

/** Tracks `$( ... )` nesting, so a separator or space inside a substitution splits nothing. */
function nextSubstitutionDepth(
  depth: number,
  char: string,
  before: string,
): number {
  if (char === '(' && before.endsWith('$')) return depth + 1;
  if (char === ')' && depth > 0) return depth - 1;
  return depth;
}

/** Splits on `|`, `&&`, `||`, `;`, and newlines outside simple quotes and `$( ... )`. */
function splitChain(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote = '';
  let substitutionDepth = 0;
  let previousChar = '';
  for (const char of command) {
    substitutionDepth = nextSubstitutionDepth(substitutionDepth, char, current);
    const isOrOperator =
      !quote && substitutionDepth === 0 && char === '|' && previousChar === '|';
    previousChar = char;
    if (isOrOperator) {
      segments.push(FALLBACK_MARKER);
    } else if (quote) {
      if (char === quote) quote = '';
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (
      substitutionDepth === 0 &&
      (char === '|' || char === '&' || char === ';' || char === '\n')
    ) {
      segments.push(current);
      current = '';
    } else current += char;
  }
  segments.push(current);
  return segments.filter((segment) => segment.trim() !== '');
}

/** Whitespace tokens with simple quotes removed. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote = '';
  let inToken = false;
  let substitutionDepth = 0;
  for (const char of segment) {
    substitutionDepth = nextSubstitutionDepth(substitutionDepth, char, current);
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
    } else if (substitutionDepth === 0 && /\s/.test(char)) {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
    } else {
      current += char;
      inToken = true;
    }
  }
  if (inToken) tokens.push(current);
  return tokens;
}

/** The first word that is not a flag or a flag's value. */
function subcommandAfter(args: string[], valueFlags: string[]): string {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (valueFlags.includes(arg)) i += 1;
    else if (!arg.startsWith('-')) return arg;
  }
  return '';
}

function runnerFamily(manager: string, args: string[]): string {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (RUNNER_VALUE_FLAGS.includes(arg)) i += 1;
    else if (!arg.startsWith('-')) rest.push(arg);
  }
  const [head, ...others] = rest;
  const subcommand = head === 'run' || head === 'exec' ? others[0] : head;
  return subcommand === undefined ? manager : `${manager} ${subcommand}`;
}

function nodeFamily(args: string[]): string {
  const [first] = args;
  if (first === undefined) return 'node';
  if (first.startsWith('-')) return `node ${first}`;
  return first.split('/').pop() ?? first;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

const MILLISECONDS_PER_SECOND = 1000;
/** Seconds keep 3 decimals, a millisecond, the resolution of a transcript timestamp. */
const SECONDS_ROUNDING_FACTOR = 1000;
const P90_QUANTILE = 0.9;
const SESSION_ID_DISPLAY_CHARS = 8;

function roundMillis(value: number): number {
  return Math.round(value * SECONDS_ROUNDING_FACTOR) / SECONDS_ROUNDING_FACTOR;
}

/**
 * A collector over one transcript, the one extractor that both the `houserules report` "Bash
 * wall time" section and `waste-audit.mjs`'s `bashWall` table read, so the two agree by
 * construction. A call's seconds run from the timestamp of the record carrying its `tool_use`
 * block to that of the record carrying the matching `tool_result`, paired by `tool_use_id`. A
 * `run_in_background` call returns at once, so it is flagged and kept out of the seconds. A call
 * with no result, or no parseable timestamp on either record, is counted and kept out. Records
 * that are not objects are ignored. `waste-audit.mjs` imports this module from
 * `packages/cli/dist/`, so it stays free of imports.
 */
export function createBashCallCollector(
  options: BashCallOptions,
): BashCallCollector {
  const calls: BashCall[] = [];
  const byId = new Map<string, BashCall>();

  function settle(call: BashCall): void {
    if (call.isBackground || call.startMs === null || call.endMs === null)
      return;
    call.seconds = roundMillis(
      (call.endMs - call.startMs) / MILLISECONDS_PER_SECOND,
    );
  }

  function recordToolUse(
    block: Record<string, unknown>,
    timestampMs: number | null,
  ): void {
    // A transcript can repeat a tool_use record, and the repeat must not count as a second call.
    if (typeof block.id === 'string' && byId.has(block.id)) return;
    const input = asRecord(block.input);
    const command = typeof input?.command === 'string' ? input.command : '';
    const call: BashCall = {
      id: typeof block.id === 'string' ? block.id : '',
      command,
      family: bashFamily(command),
      startMs: timestampMs,
      endMs: null,
      seconds: null,
      isBackground: input?.run_in_background === true,
      isSubagent: options.isSubagent,
    };
    calls.push(call);
    if (call.id) byId.set(call.id, call);
  }

  function recordToolResult(
    toolUseId: string,
    timestampMs: number | null,
  ): void {
    const call = byId.get(toolUseId);
    if (!call || call.endMs !== null) return;
    call.endMs = timestampMs;
    settle(call);
  }

  return {
    add(record) {
      const content = asRecord(asRecord(record)?.message)?.content;
      if (!Array.isArray(content)) return;
      const timestampMs = parseTimestamp(asRecord(record)?.timestamp);
      for (const rawBlock of content) {
        const block = asRecord(rawBlock);
        if (block?.type === 'tool_use' && block.name === 'Bash')
          recordToolUse(block, timestampMs);
        else if (
          block?.type === 'tool_result' &&
          typeof block.tool_use_id === 'string'
        )
          recordToolResult(block.tool_use_id, timestampMs);
      }
    },
    finish: () => calls,
  };
}

/** Every Bash call in one transcript's parsed records, through {@link createBashCallCollector}. */
export function extractBashCalls(
  records: Iterable<unknown>,
  options: BashCallOptions,
): BashCall[] {
  const collector = createBashCallCollector(options);
  for (const record of records) collector.add(record);
  return collector.finish();
}

/** Folds tagged calls into the per-family table and the slowest-calls list. */
export function summarizeBashWall(
  calls: readonly SessionBashCall[],
  options: SummarizeOptions = {},
): BashWallReport {
  const timedCalls = calls.filter((call) => call.seconds !== null);
  const byFamily = new Map<string, SessionBashCall[]>();
  for (const call of timedCalls) {
    const group = byFamily.get(call.family) ?? [];
    group.push(call);
    byFamily.set(call.family, group);
  }
  const families = [...byFamily].map(([family, group]) =>
    familyWall(family, group),
  );
  families.sort(
    (a, b) => b.seconds - a.seconds || compareText(a.family, b.family),
  );
  const slowest = timedCalls.map((call): SlowCall => ({
    family: call.family,
    command: call.command.slice(0, SLOW_COMMAND_MAX_CHARS),
    seconds: call.seconds ?? 0,
    session: call.session,
    startedAt: new Date(call.startMs ?? 0).toISOString(),
    isSubagent: call.isSubagent,
  }));
  slowest.sort(
    (a, b) => b.seconds - a.seconds || compareText(a.startedAt, b.startedAt),
  );
  const background = calls.filter((call) => call.isBackground).length;
  return {
    calls: calls.length,
    timed: timedCalls.length,
    background,
    unanswered: calls.length - timedCalls.length - background,
    includesSubagents: calls.some((call) => call.isSubagent),
    families: families.slice(0, options.families ?? TOP_FAMILIES),
    slowest: slowest.slice(0, options.slowest ?? SLOWEST_CALLS),
  };
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function familyWall(family: string, group: SessionBashCall[]): FamilyWall {
  const sorted = group.map((call) => call.seconds ?? 0).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return {
    family,
    calls: sorted.length,
    subagentCalls: group.filter((call) => call.isSubagent).length,
    unscopedCalls: group.filter((call) => isUnscopedRunnerCall(call.command))
      .length,
    seconds: roundMillis(sorted.reduce((sum, value) => sum + value, 0)),
    medianSeconds: roundMillis(median),
    p90Seconds: sorted[Math.ceil(P90_QUANTILE * sorted.length) - 1] ?? 0,
  };
}

/**
 * The "Bash wall time" report section. Its first line under the heading says that parallel
 * calls overlap, so family totals can exceed a session's wall, and whether subagent
 * transcripts are counted. Then the per-family table, whose last column counts package-runner
 * calls with no scope flag, then the slowest calls with session
 * and timestamp. An empty report renders no lines.
 */
export function renderBashWall(report: BashWallReport | undefined): string[] {
  if (!report || report.calls === 0) return [];
  const subagentNote = report.includesSubagents
    ? 'subagent transcripts are counted'
    : 'subagent transcripts are not counted';
  const lines = [
    '-- bash wall time --',
    `  parallel calls overlap, so family totals can exceed a session's wall. ${subagentNote}.`,
    `  calls ${report.calls}, timed ${report.timed}, background ${report.background}, unanswered ${report.unanswered}`,
    '',
    ...renderTable(
      [
        'family',
        'calls',
        'total s',
        'median s',
        'p90 s',
        'subagent calls',
        'unscoped calls',
      ],
      report.families.map((row) => [
        row.family,
        row.calls,
        row.seconds.toFixed(2),
        row.medianSeconds.toFixed(2),
        row.p90Seconds.toFixed(2),
        row.subagentCalls,
        row.unscopedCalls,
      ]),
    ),
    '',
    '  slowest calls:',
    ...report.slowest.map(
      (call) =>
        `    ${call.seconds.toFixed(2)}s  ${call.family}  ${call.session.slice(0, SESSION_ID_DISPLAY_CHARS)}  ${call.startedAt}  ${call.command}`,
    ),
  ];
  return lines;
}
