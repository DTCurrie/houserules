#!/usr/bin/env node
/**
 * PreToolUse(Bash) guard. Blocks the git commands the user always runs themselves, plus
 * `git stash`, which dumps the whole untracked-file list into context, plus the discard
 * family (`checkout`, `restore`, `reset --hard`, `clean`, `switch -f`), and refuses ledger
 * and changeset writes from any subagent turn.
 *
 * The discard family is blocked because a revert to HEAD throws away every uncommitted
 * change in the file, not only the edit being undone, and an orchestrated tree can carry
 * many waves of uncommitted work. `checkout` is blocked in every form, since the discarding
 * forms (`-- <path>`, `.`, `<ref> <path>`) cannot be told from a branch switch without a
 * shell parser, and `git switch` covers the switch.
 *
 * The git and gh rules match per simple command, after the command is tokenized the way
 * the shell reads it. A quoted argument, a heredoc body, or a comment is data and never
 * matches. A command inside `$(...)`, backticks, `<(...)`, `bash -c`, `sh -c`, or `eval`
 * is matched as a command. A command with an unclosed quote, substitution, or heredoc is
 * refused whenever the plain match would refuse it, or a reading that runs each open
 * construct to the end of the command finds a guarded call.
 *
 * Throwaway exemption: a commit or a discard is allowed in a throwaway fixture repo, and in
 * nothing else. The command must name its target as one absolute `-C <path>` on every git
 * call, or as one leading `cd <absolute path> &&`. That target's work tree, git dir, and
 * common dir must sit under the system temp dir or `/tmp`, outside `CLAUDE_PROJECT_DIR`,
 * with a common dir that differs from the project's. No fetch or push URL of any remote may
 * name the project's path, its common dir, or one of its remote URLs. Local remotes are
 * followed to their own remotes for a fixed number of hops. A form the resolver does not
 * recognize refuses: a relative or variable path, a second `cd`, `$(...)`, a backtick, any
 * `GIT_` text, `--git-dir`, `--work-tree`, or a `-c` key other than `user.name`,
 * `user.email`, and `commit.gpgsign`. A git failure refuses, and so does an unset
 * `CLAUDE_PROJECT_DIR`. A bare `git commit` names no target, so it always refuses. The
 * exemption never reaches `push`, `stash`, `gh`, or a custom rule, and it runs git only
 * after a commit or discard rule has matched.
 *
 * Exit 2 with stderr blocks the tool call and feeds the reason back to Claude. Exit 0
 * allows. Wire it as a PreToolUse hook with matcher "Bash".
 *
 * Config (.claude/houserules.config.json, all default on):
 *   "guard": { "gitCommit": true, "gitPush": true, "gitStash": true, "gitDiscard": true,
 *              "prCreate": true,
 *              "custom": [{ "pattern": "\\bdocker\\s+system\\s+prune\\b", "message": "..." }] }
 * A missing or unreadable config falls back to the five defaults.
 *
 * Subagent write gate: the hook payload carries `agent_id` whenever the hook fires inside
 * a subagent, and omits it on the main thread. The gate reads that field and nothing else.
 * The transcript is not consulted on the hook path, because it is written asynchronously
 * and lags the in-memory turn, so a subagent's first writes would look like main-thread
 * ones. The gate covers every subagent rather than one particular agent type.
 *
 * Scope: subagents authoring changesets one-per-incremental-change instead of one-per-
 * feature has produced changeset pollution, so both the backlog/decision ledgers and
 * `.changeset/` are refused from any subagent. Reads stay allowed everywhere.
 *
 * When identity can't be established (no `agent_id`), the gate allows, because a false
 * refusal blocks legitimate work far worse than a missed write.
 *
 * `--diagnose <transcript-path>` is a separate, manually-run mode (never invoked by the
 * hook itself) kept for inspecting an old session. It reports whether the transcript's
 * trailing turn is a sidechain, printing JSON and exiting 0 when it is, 1 when it is not.
 * It says nothing about what the hook decided at the time.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { GUARD_DEFAULTS, loadConfigSafe } from '@houserules/payload/config';
import { readStdinJson } from '@houserules/payload/proc';

interface BashPayload {
  tool_input?: { command?: string };
  transcript_path?: string;
  agent_id?: string;
  agent_type?: string;
}

export interface TranscriptRecord {
  type?: string;
  isSidechain?: boolean;
}

/** Where a commit or discard may count as throwaway: never in the project, only under a temp root. */
export interface ThrowawayContext {
  projectDir: string | undefined;
  tempRoots: string[];
}

// Matches only in COMMAND position, so the guard never fires on the same words inside
// another command's argument. The git rules run per tokenized segment, see commandSegmentsOf.
const CMD_START = String.raw`(?:^|[\n;&|])\s*`;
// Tolerate flag/option arguments before a git subcommand: `git -C /path commit`,
// `git -c k=v stash`, `git --no-pager push`.
const GIT_FLAGS = String.raw`(?:-[A-Za-z]\s+\S+\s+|--?\S+\s+)*`;
// The subcommands that discard uncommitted work. `reset` and `switch` only do so under the
// named flag, matched within the one command and bounded so `-f` never matches `feature-flag`.
const GIT_DISCARD = String.raw`(?:checkout\b|restore\b|clean\b|reset\b[^\n;&|]*\s--(?:hard|merge)(?![\w-])|switch\b[^\n;&|]*\s(?:-f|--force|--discard-changes)(?![\w-]))`;

// Only the stash subcommands that change state. Bare `stash` and `stash -u` are a push, so a
// flag or a separator after the word counts. `list` and `show` read only and pass.
const STASH_MUTATING = String.raw`stash(?=\s*(?:$|[\n;&|])|\s+-|\s+(?:push|save|pop|apply|drop|clear|branch|create|store)\b)`;

/**
 * One guard rule. A `segment` rule is tested against each tokenized command segment, so a
 * quoted mention never matches and a nested command still does. A `command` rule, the
 * user's custom regex, is tested against the raw command string.
 */
interface DenyRule {
  re: RegExp;
  msg: string;
  exemptable: boolean;
  scope: 'segment' | 'command';
}

export function gitDenyRules(guard: {
  gitCommit: boolean;
  gitPush: boolean;
  gitStash: boolean;
  gitDiscard: boolean;
  prCreate: boolean;
  custom?: { pattern: string; message: string }[];
}): DenyRule[] {
  const gitRule = (
    sub: string,
    msg: string,
    exemptable: boolean,
  ): DenyRule => ({
    re: new RegExp(`${CMD_START}git\\s+${GIT_FLAGS}${sub}\\b`),
    msg,
    exemptable,
    scope: 'segment',
  });

  const deny: DenyRule[] = [];
  if (guard.gitCommit) {
    deny.push(
      gitRule(
        'commit',
        "git commit is the user's to run. Describe what's staged and stop.",
        true,
      ),
    );
  }
  if (guard.gitPush) {
    deny.push(gitRule('push', "git push is the user's to run.", false));
  }
  if (guard.gitStash) {
    deny.push(
      gitRule(
        STASH_MUTATING,
        'git stash dumps the full untracked-file list into context. Use `git diff --name-only`, `git show HEAD:<path>`, or inspect the one file you changed.',
        false,
      ),
    );
  }
  if (guard.gitDiscard) {
    deny.push({
      re: new RegExp(`${CMD_START}git\\s+${GIT_FLAGS}${GIT_DISCARD}`),
      msg: 'git checkout/restore/reset --hard/clean/switch -f discard uncommitted work, and a file reverted to HEAD loses every uncommitted edit in it, not only yours. Undo your own edit by applying its inverse with Edit. Switch branches with `git switch`. List untracked files with `git status --short`.',
      exemptable: true,
      scope: 'segment',
    });
  }
  if (guard.prCreate) {
    deny.push({
      re: new RegExp(`${CMD_START}gh\\s+${GIT_FLAGS}(?:pr|issue)\\s+create\\b`),
      msg: "Opening PRs/issues is the user's call. Describe what's ready and stop.",
      exemptable: false,
      scope: 'segment',
    });
  }
  for (const rule of guard.custom ?? []) {
    try {
      deny.push({
        re: new RegExp(rule.pattern),
        msg: rule.message,
        exemptable: false,
        scope: 'command',
      });
    } catch {
      // Invalid user regex: skip the rule rather than break every Bash call.
    }
  }
  return deny;
}

/**
 * The stderr message refusing `cmd` under the git/gh guard config, or null when nothing
 * matches.
 *
 * @param throwaway When given, a matched commit or discard rule is skipped for a command
 * whose one named target is a throwaway fixture repo. Omitted, every match refuses. A match
 * inside a nested command, or in a command that does not tokenize cleanly, is never skipped.
 */
export function guardRefusalFor(
  cmd: string,
  throwaway?: ThrowawayContext,
): string | null {
  const guard = { ...GUARD_DEFAULTS, ...(loadConfigSafe().guard ?? {}) };
  const tokenized = tokenizeCommand(cmd);
  let isExempt: boolean | undefined;
  for (const rule of gitDenyRules(guard)) {
    const match = ruleMatchOf(rule, cmd, tokenized);
    if (match === 'none') continue;
    if (rule.exemptable && throwaway && match === 'top-level') {
      isExempt ??= isThrowawayCommand(cmd, throwaway);
      if (isExempt) continue;
    }
    return `Blocked by houserules guard: ${rule.msg}\n`;
  }
  return null;
}

/**
 * Where `rule` matches `cmd`. A command that did not tokenize cleanly is also tested raw,
 * the plain match the guard used before it tokenized, so a parse failure never allows more.
 */
function ruleMatchOf(
  rule: DenyRule,
  cmd: string,
  tokenized: TokenizedCommand,
): 'none' | 'top-level' | 'nested' | 'unparsed' {
  if (rule.scope === 'command') return rule.re.test(cmd) ? 'top-level' : 'none';
  const matched = tokenized.segments.filter((segment) =>
    rule.re.test(segment.text),
  );
  if (!tokenized.isClean && (matched.length > 0 || rule.re.test(cmd))) {
    return 'unparsed';
  }
  if (matched.length === 0) return 'none';
  return matched.some((segment) => segment.isNested) ? 'nested' : 'top-level';
}

/** One simple command, its words after quote removal, joined for the segment rules. */
interface CommandSegment {
  text: string;
  /** Whether it runs from a substitution, a heredoc expansion, `sh -c`, or `eval`. */
  isNested: boolean;
}

interface TokenizedCommand {
  segments: CommandSegment[];
  /** False when a quote, substitution, or heredoc was left open, or nesting ran too deep. */
  isClean: boolean;
}

class ShellSyntaxError extends Error {}

// Deeper than any real command, shallow enough that recursion cannot exhaust the stack.
const MAX_NESTING = 16;
// Stands in for a substitution's output, so a substituted option value stays one word.
const SUBSTITUTION_WORD = '$()';
const SHELL_PROGRAMS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const SHELL_COMMAND_FLAG_RE = /^-[A-Za-z]*c[A-Za-z]*$/;
const COMMAND_PREFIX_WORDS = new Set([
  '!',
  '{',
  '}',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  'time',
]);
const ASSIGNMENT_RE = /^[A-Za-z_]\w*\+?=/;
const WORD_BREAK_RE = /[\s;&|]/g;
const DOUBLE_QUOTE_ESCAPABLE = '$`"\\\n';
const BACKTICK_ESCAPABLE = '$`\\';
const HEREDOC_DELIMITER_END_RE = /[\s;&|<>()]/;

/**
 * Splits `cmd` into its simple commands the way the shell would: quotes and escapes are
 * removed, a quoted argument or heredoc body stays data, and the commands inside `$(...)`,
 * backticks, `<(...)`, an unquoted heredoc's expansions, `bash -c`, and `eval` become
 * segments of their own. Fails closed: a command left open is read again with every open
 * quote, substitution, and heredoc running to the end, and flagged unclean.
 */
function tokenizeCommand(cmd: string): TokenizedCommand {
  for (const isLenient of [false, true]) {
    const segments: CommandSegment[] = [];
    try {
      new ShellScanner(cmd, 0, segments, 0, isLenient).run(false);
      return { segments, isClean: !isLenient };
    } catch {
      // A strict failure retries leniently. A lenient one falls through to the raw match.
    }
  }
  return { segments: [], isClean: false };
}

interface PendingHeredoc {
  delimiter: string;
  isQuoted: boolean;
  stripsTabs: boolean;
}

/** A single pass over shell source, appending each simple command it ends to `out`. */
class ShellScanner {
  private readonly source: string;
  private readonly out: CommandSegment[];
  private readonly depth: number;
  private readonly isLenient: boolean;
  private pos: number;
  private words: string[] = [];
  private word = '';
  private hasWord = false;
  private parenDepth = 0;
  private heredocs: PendingHeredoc[] = [];

  constructor(
    source: string,
    start: number,
    out: CommandSegment[],
    depth: number,
    isLenient: boolean,
  ) {
    if (depth > MAX_NESTING) throw new ShellSyntaxError('nesting too deep');
    this.source = source;
    this.pos = start;
    this.out = out;
    this.depth = depth;
    this.isLenient = isLenient;
  }

  /**
   * Scans to the end of the source, or to the `)` closing a `$(` when `closesParen`.
   *
   * @returns The index just past the last character consumed.
   */
  run(closesParen: boolean): number {
    while (this.pos < this.source.length) {
      const char = this.source[this.pos] ?? '';
      if (char === ')' && closesParen && this.parenDepth === 0) {
        this.endSegment();
        this.dropHeredocs();
        return this.pos + 1;
      }
      this.step(char);
    }
    if (closesParen) this.fail('unclosed $(');
    this.endSegment();
    this.dropHeredocs();
    return this.pos;
  }

  private step(char: string): void {
    switch (char) {
      case '\\':
        return this.readEscape();
      case "'":
        return this.append(this.readSingleQuoted());
      case '"':
        this.pos++;
        return this.readQuotedWord();
      case '`':
        return this.readBacktick();
      case '$':
        return this.readDollar();
      case '\n':
        this.endSegment();
        this.pos++;
        return this.readHeredocBodies();
      case ';':
      case '|':
        return this.breakSegment();
      case '(':
        this.parenDepth++;
        return this.breakSegment();
      case ')':
        this.parenDepth = Math.max(0, this.parenDepth - 1);
        return this.breakSegment();
      case ' ':
      case '\t':
        this.endWord();
        this.pos++;
        return;
    }
    if (char === '#' && !this.hasWord) return this.skipComment();
    if (char === '&' && !this.isRedirectAmpersand()) return this.breakSegment();
    if ((char === '<' || char === '>') && this.readRedirection(char)) return;
    this.append(char);
    this.pos++;
  }

  private fail(reason: string): void {
    if (!this.isLenient) throw new ShellSyntaxError(reason);
  }

  private append(text: string): void {
    this.word += text;
    this.hasWord = true;
  }

  private endWord(): void {
    if (this.hasWord) this.words.push(this.word);
    this.word = '';
    this.hasWord = false;
  }

  private breakSegment(): void {
    this.endSegment();
    this.pos++;
  }

  private endSegment(): void {
    this.endWord();
    const words = commandWordsOf(this.words);
    this.words = [];
    if (words.length === 0) return;
    this.out.push({
      text: words.map(segmentWord).join(' '),
      isNested: this.depth > 0,
    });
    this.scanNestedShell(words);
  }

  /** Scans the script a `bash -c`, `sh -c`, or `eval` runs as commands of its own. */
  private scanNestedShell(words: string[]): void {
    const [program = '', ...args] = words;
    if (program === 'eval') return this.scanNested(args.join(' '));
    if (!SHELL_PROGRAMS.has(basename(program))) return;
    const flagIndex = args.findIndex((arg) => SHELL_COMMAND_FLAG_RE.test(arg));
    if (flagIndex === -1) return;
    const script = args
      .slice(flagIndex + 1)
      .find((arg) => !arg.startsWith('-'));
    if (script !== undefined) this.scanNested(script);
  }

  private scanNested(source: string): void {
    new ShellScanner(source, 0, this.out, this.depth + 1, this.isLenient).run(
      false,
    );
  }

  private readEscape(): void {
    const next = this.source[this.pos + 1];
    if (next === undefined) {
      this.append('\\');
      this.pos++;
      return;
    }
    this.pos += 2;
    if (next === '\n') return;
    this.append(next);
  }

  private readSingleQuoted(): string {
    const end = this.source.indexOf("'", this.pos + 1);
    if (end === -1) this.fail("unclosed '");
    const stop = end === -1 ? this.source.length : end;
    const text = this.source.slice(this.pos + 1, stop);
    this.pos = stop + 1;
    return text;
  }

  /** Reads one double-quoted word, up to its closing `"`. Substitutions inside still run. */
  private readQuotedWord(): void {
    this.hasWord = true;
    while (this.pos < this.source.length) {
      if (this.source[this.pos] === '"') {
        this.pos++;
        return;
      }
      this.readQuotedCharacter();
    }
    this.fail('unclosed "');
  }

  /** Reads an unquoted heredoc body to its end, as double-quoted text. Substitutions still run. */
  private readUnquotedHeredocBody(): void {
    this.hasWord = true;
    while (this.pos < this.source.length) this.readQuotedCharacter();
  }

  private readQuotedCharacter(): void {
    const char = this.source[this.pos] ?? '';
    const next = this.source[this.pos + 1] ?? '';
    if (char === '\\' && next !== '' && DOUBLE_QUOTE_ESCAPABLE.includes(next)) {
      if (next !== '\n') this.append(next);
      this.pos += 2;
    } else if (char === '`') {
      this.readBacktick();
    } else if (char === '$' && next === '(') {
      this.readSubstitution(this.pos + 2);
    } else {
      this.append(char);
      this.pos++;
    }
  }

  private readDollar(): void {
    const next = this.source[this.pos + 1];
    if (next === '(') return this.readSubstitution(this.pos + 2);
    if (next === '"') {
      this.pos += 2;
      return this.readQuotedWord();
    }
    if (next === "'") {
      this.pos++;
      return this.append(this.readAnsiCQuoted());
    }
    this.append('$');
    this.pos++;
  }

  private readAnsiCQuoted(): string {
    let text = '';
    let index = this.pos + 1;
    while (index < this.source.length && this.source[index] !== "'") {
      if (this.source[index] === '\\') index++;
      text += this.source[index] ?? '';
      index++;
    }
    if (index >= this.source.length) this.fail("unclosed $'");
    this.pos = index + 1;
    return text;
  }

  private readSubstitution(start: number): void {
    const inner = new ShellScanner(
      this.source,
      start,
      this.out,
      this.depth + 1,
      this.isLenient,
    );
    this.pos = inner.run(true);
    this.append(SUBSTITUTION_WORD);
  }

  private readBacktick(): void {
    let body = '';
    let index = this.pos + 1;
    while (index < this.source.length && this.source[index] !== '`') {
      const char = this.source[index] ?? '';
      const next = this.source[index + 1] ?? '';
      if (char === '\\' && next !== '' && BACKTICK_ESCAPABLE.includes(next)) {
        body += next;
        index += 2;
      } else {
        body += char;
        index++;
      }
    }
    if (index >= this.source.length) this.fail('unclosed `');
    this.pos = index + 1;
    this.scanNested(body);
    this.append(SUBSTITUTION_WORD);
  }

  private skipComment(): void {
    const end = this.source.indexOf('\n', this.pos);
    this.pos = end === -1 ? this.source.length : end;
  }

  /** Whether the `&` at the cursor belongs to a redirection such as `2>&1` or `&>file`. */
  private isRedirectAmpersand(): boolean {
    const previous = this.source[this.pos - 1];
    const next = this.source[this.pos + 1];
    return previous === '>' || previous === '<' || next === '>';
  }

  /** Reads a process substitution, here-string, or heredoc operator. False for any other. */
  private readRedirection(char: string): boolean {
    const next = this.source[this.pos + 1];
    if (next === '(' && !this.hasWord) {
      this.readSubstitution(this.pos + 2);
      return true;
    }
    if (char !== '<' || next !== '<') return false;
    if (this.source[this.pos + 2] === '<') {
      this.append('<<<');
      this.pos += 3;
      return true;
    }
    this.endWord();
    this.pos += 2;
    this.readHeredocOperator();
    return true;
  }

  private readHeredocOperator(): void {
    const stripsTabs = this.source[this.pos] === '-';
    if (stripsTabs) this.pos++;
    while (this.source[this.pos] === ' ' || this.source[this.pos] === '\t') {
      this.pos++;
    }
    let delimiter = '';
    let isQuoted = false;
    while (this.pos < this.source.length) {
      const char = this.source[this.pos] ?? '';
      if (HEREDOC_DELIMITER_END_RE.test(char)) break;
      if (char === "'" || char === '"') {
        isQuoted = true;
        const end = this.source.indexOf(char, this.pos + 1);
        if (end === -1) this.fail('unclosed heredoc delimiter');
        const stop = end === -1 ? this.source.length : end;
        delimiter += this.source.slice(this.pos + 1, stop);
        this.pos = stop + 1;
      } else if (char === '\\') {
        isQuoted = true;
        delimiter += this.source[this.pos + 1] ?? '';
        this.pos += 2;
      } else {
        delimiter += char;
        this.pos++;
      }
    }
    if (delimiter === '') return this.fail('empty heredoc delimiter');
    this.heredocs.push({ delimiter, isQuoted, stripsTabs });
  }

  /**
   * Consumes the bodies of the heredocs opened on the line just ended. A quoted delimiter's
   * body is data. An unquoted one's substitutions still run.
   */
  private readHeredocBodies(): void {
    const pending = this.heredocs;
    this.heredocs = [];
    for (const heredoc of pending) {
      const bodyStart = this.pos;
      const bodyEnd = this.findHeredocEnd(heredoc);
      if (bodyEnd === -1) {
        this.fail('unterminated heredoc');
        this.pos = bodyStart;
        return;
      }
      if (heredoc.isQuoted) continue;
      new ShellScanner(
        this.source.slice(bodyStart, bodyEnd),
        0,
        this.out,
        this.depth,
        this.isLenient,
      ).readUnquotedHeredocBody();
    }
  }

  /**
   * Moves the cursor past the line closing `heredoc`.
   *
   * @returns The index where the body ends, or -1 when no line closes it.
   */
  private findHeredocEnd(heredoc: PendingHeredoc): number {
    while (this.pos < this.source.length) {
      const newline = this.source.indexOf('\n', this.pos);
      const lineEnd = newline === -1 ? this.source.length : newline;
      const line = this.source.slice(this.pos, lineEnd);
      const lineStart = this.pos;
      this.pos = lineEnd + 1;
      const candidate = heredoc.stripsTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === heredoc.delimiter) {
        this.pos = Math.min(this.pos, this.source.length);
        return lineStart;
      }
    }
    return -1;
  }

  /** A heredoc opened on a line that never ended has no body. Strict mode refuses it. */
  private dropHeredocs(): void {
    if (this.heredocs.length > 0) this.fail('heredoc with no body');
    this.heredocs = [];
  }
}

/** `words` without the keywords and variable assignments that precede a command name. */
function commandWordsOf(words: string[]): string[] {
  const start = words.findIndex(
    (word) => !COMMAND_PREFIX_WORDS.has(word) && !ASSIGNMENT_RE.test(word),
  );
  return start === -1 ? [] : words.slice(start);
}

/** One word as a single space-free token, so the segment rules see its boundaries. */
function segmentWord(word: string): string {
  return word === '' ? "''" : word.replace(WORD_BREAK_RE, '_');
}

// How many local-path remotes the resolver follows from the target before it refuses.
const HOP_LIMIT = 4;
const GIT_TIMEOUT_MS = 5000;
const ALLOWED_CONFIG_KEYS = new Set([
  'user.name',
  'user.email',
  'commit.gpgsign',
]);
const UNRECOGNIZED_TEXT_RE = /\$\(|`|GIT_|--git-dir|--work-tree/;
const LEADING_CD_RE = /^\s*cd\s+(\S+)\s*&&([\s\S]*)$/;
const DIRECTORY_CHANGE_RE =
  /(?:^|[\s;&|(){}"'])(?:cd|pushd|popd)(?=$|[\s;&|(){}"'])/;
// No quotes, `$`, `~`, globs, or backslashes, so the shell cannot expand it into another path.
const PLAIN_ABSOLUTE_PATH_RE = /^\/[\w./@+,%=:-]*$/;
const SUBCOMMAND_RE = /^[a-z][a-z-]*$/;
const SEGMENT_SEPARATOR_RE = /[\n;&|]+/;
const SEGMENT_PREFIX_RE = /^[\s({!"']+/;

interface ProjectIdentity {
  dir: string;
  commonDir: string;
  remoteUrls: Set<string>;
}

/** Whether `cmd` names exactly one target and that target is a throwaway fixture repo. */
function isThrowawayCommand(cmd: string, context: ThrowawayContext): boolean {
  const target = targetOf(cmd);
  if (!target || !context.projectDir) return false;
  try {
    return isThrowawayRepo(target, context.projectDir, context.tempRoots);
  } catch {
    return false;
  }
}

/**
 * The one directory every git call in `cmd` runs in, from a leading `cd <path> &&` or from
 * the same `-C <path>` on every git call. Null for any form the resolver does not recognize.
 */
function targetOf(cmd: string): string | null {
  if (UNRECOGNIZED_TEXT_RE.test(cmd)) return null;
  const leadingCd = LEADING_CD_RE.exec(cmd);
  const cdTarget = leadingCd?.[1];
  const rest = leadingCd ? (leadingCd[2] ?? '') : cmd;
  if (cdTarget !== undefined && !PLAIN_ABSOLUTE_PATH_RE.test(cdTarget)) {
    return null;
  }
  if (DIRECTORY_CHANGE_RE.test(rest)) return null;

  const cTargets = new Set<string>();
  for (const segment of rest.split(SEGMENT_SEPARATOR_RE)) {
    const words = segment.replace(SEGMENT_PREFIX_RE, '').split(/\s+/);
    if (words[0] !== 'git') continue;
    const invocation = gitInvocationOf(words);
    if (!invocation) return null;
    const hasDashCTarget = invocation.cTarget !== undefined;
    if (hasDashCTarget === (cdTarget !== undefined)) return null;
    if (invocation.cTarget) cTargets.add(invocation.cTarget);
  }
  if (cdTarget !== undefined) return cdTarget;
  return cTargets.size === 1 ? ([...cTargets][0] ?? null) : null;
}

/**
 * A git call's `-C` target, read from its global options. Null when an option is anything
 * but one plain absolute `-C` or an allowlisted `-c`, or when no plain subcommand follows.
 */
function gitInvocationOf(
  words: string[],
): { cTarget: string | undefined } | null {
  let cTarget: string | undefined;
  let index = 1;
  for (; words[index]?.startsWith('-'); index += 2) {
    const value = words[index + 1];
    if (value === undefined) return null;
    if (words[index] === '-C') {
      if (cTarget !== undefined || !PLAIN_ABSOLUTE_PATH_RE.test(value)) {
        return null;
      }
      cTarget = value;
    } else if (words[index] === '-c') {
      const key = value.split('=')[0]?.toLowerCase() ?? '';
      if (!value.includes('=') || /["'\\]/.test(value)) return null;
      if (!ALLOWED_CONFIG_KEYS.has(key)) return null;
    } else {
      return null;
    }
  }
  const subcommand = words[index];
  if (subcommand === undefined || !SUBCOMMAND_RE.test(subcommand)) return null;
  return { cTarget };
}

/**
 * Whether the repo at `target` is a throwaway fixture: under a temp root, outside the
 * project, and with no remote that leads back to the project. Throws on any git failure.
 */
function isThrowawayRepo(
  target: string,
  projectDir: string,
  tempRoots: string[],
): boolean {
  const roots = tempRoots.flatMap((root) => {
    try {
      return [realpathSync(root)];
    } catch {
      return [];
    }
  });
  const project = projectIdentity(realpathSync(projectDir));
  const paths = runGit(realpathSync(target), [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-dir',
    '--git-common-dir',
  ]).split('\n');
  if (paths.length !== 3) return false;
  const [topLevel, gitDir, commonDir] = paths.map((path) => realpathSync(path));
  if (!topLevel || !gitDir || !commonDir) return false;

  for (const path of [topLevel, gitDir, commonDir]) {
    if (!roots.some((root) => path.startsWith(root + sep))) return false;
    if (isWithin(path, project.dir)) return false;
  }
  if (isWithin(project.dir, topLevel)) return false;
  if (commonDir === project.commonDir) return false;
  return areRemotesForeign(topLevel, project, 0, new Set([commonDir]));
}

function projectIdentity(dir: string): ProjectIdentity {
  const commonDir = realpathSync(
    runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  const remoteUrls = new Set(remoteUrlsOf(dir).map(normalizeRemoteUrl));
  return { dir, commonDir, remoteUrls };
}

/**
 * Whether no remote of the repo at `repoDir` leads to the project, following local-path
 * remotes up to {@link HOP_LIMIT} hops. `depth` is the hop count of `repoDir` itself.
 */
function areRemotesForeign(
  repoDir: string,
  project: ProjectIdentity,
  depth: number,
  visited: Set<string>,
): boolean {
  for (const url of remoteUrlsOf(repoDir)) {
    const localPath = localPathOf(url, repoDir);
    if (localPath === null) {
      if (project.remoteUrls.has(normalizeRemoteUrl(url))) return false;
      continue;
    }
    const resolved = realpathSync(localPath);
    if (isWithin(resolved, project.dir)) return false;
    if (isWithin(resolved, project.commonDir)) return false;
    if (depth + 1 > HOP_LIMIT) return false;
    if (!isHopForeign(resolved, project, depth + 1, visited)) return false;
  }
  return true;
}

/** Whether a repo reached through a local remote is neither the project nor leads to it. */
function isHopForeign(
  dir: string,
  project: ProjectIdentity,
  depth: number,
  visited: Set<string>,
): boolean {
  const commonDir = realpathSync(
    runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  if (commonDir === project.commonDir) return false;
  if (visited.has(commonDir)) return true;
  visited.add(commonDir);
  const isBare = runGit(dir, ['rev-parse', '--is-bare-repository']) === 'true';
  const base = isBare
    ? commonDir
    : realpathSync(runGit(dir, ['rev-parse', '--show-toplevel']));
  if (isWithin(base, project.dir)) return false;
  return areRemotesForeign(base, project, depth, visited);
}

function remoteUrlsOf(repoDir: string): string[] {
  const names = runGit(repoDir, ['remote']).split('\n').filter(Boolean);
  return names.flatMap((name) => [
    ...runGit(repoDir, ['remote', 'get-url', '--all', name]).split('\n'),
    ...runGit(repoDir, ['remote', 'get-url', '--push', '--all', name]).split(
      '\n',
    ),
  ]);
}

/**
 * The filesystem path a remote URL names, resolved against the repo that holds it, or null
 * for a network URL in `scheme://` or scp-like `host:path` form.
 */
function localPathOf(url: string, repoDir: string): string | null {
  if (/^file:\/\//i.test(url)) return fileURLToPath(url);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return null;
  if (/^[^/]*:/.test(url)) return null;
  return resolve(repoDir, url);
}

/**
 * A network remote URL reduced to `host/path`, so the `https`, `ssh://`, and scp-like forms
 * of one repo compare equal, ignoring case, user, port, a trailing slash, and `.git`.
 */
function normalizeRemoteUrl(url: string): string {
  let normalized = url.trim().toLowerCase();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(normalized);
  if (scheme) {
    normalized = normalized.slice(scheme[0].length);
  } else {
    normalized = normalized.replace(/^([^/:]+):/, '$1/');
  }
  return normalized
    .replace(/^[^@/]*@/, '')
    .replace(/^([^/:]+):\d*(?=\/)/, '$1')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

function isWithin(path: string, root: string): boolean {
  return (
    path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
  );
}

/** Runs git in `dir` with every `GIT_` variable stripped, so the hook's env cannot redirect it. */
function runGit(dir: string, args: string[]): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env,
    timeout: GIT_TIMEOUT_MS,
  }).trim();
}

const BACKLOG_MUTATING = ['add', 'remove', 'update', 'move', 'render'];
const BACKLOG_MUTATING_RE = new RegExp(
  `${CMD_START}node\\s+\\S*backlog-log\\.mjs\\s+(${BACKLOG_MUTATING.join('|')})\\b`,
);

const DECISION_MUTATING = [
  'decide',
  'supersede',
  'amend',
  'move',
  'rescope',
  'render',
];
const DECISION_MUTATING_RE = new RegExp(
  `${CMD_START}node\\s+\\S*decision-log\\.mjs\\s+(${DECISION_MUTATING.join('|')})\\b`,
);

// changeset-write.mjs has no read-only subcommand: any invocation writes a changeset.
const CHANGESET_WRITE_RE = new RegExp(
  `${CMD_START}node\\s+\\S*changeset-write\\.mjs\\b`,
);

// Direct edits to a ledger or changeset surface, bypassing the CLI scripts entirely.
// `sed -i`/`tee` are checked in command position, like the subcommand matches above, so a
// read command whose ARGUMENT happens to contain the word "tee" (e.g. a grep pattern)
// never trips it. Redirection (`>`/`>>`) is checked separately, unanchored, since it is a
// shell operator that appears after the command rather than in command position.
const LEDGER_TARGET = String.raw`(?:BACKLOG\.md|DECISIONS\.md|ledgers/backlog\.jsonl|ledgers/decisions\.jsonl|\.changeset/[\w.-]+\.(?:md|json))`;
const DIRECT_EDIT_RE = new RegExp(
  `${CMD_START}(?:sed\\s+-i\\b|tee\\b).*?${LEDGER_TARGET}`,
);
const REDIRECT_RE = new RegExp(
  `(?:^|[\\s;&|])>>?\\s*(?:\\S*/)?${LEDGER_TARGET}\\b`,
);

/**
 * The stderr message refusing `cmd` under the subagent write gate, or null when the
 * command cannot write a ledger or a changeset.
 *
 * Every check here is a regex over one string, so the overwhelming majority of Bash calls
 * (which are not mutating) are answered before the payload's identity is looked at.
 */
export function writeGateRefusalFor(cmd: string): string | null {
  const mutatingMatch =
    cmd.match(BACKLOG_MUTATING_RE) ?? cmd.match(DECISION_MUTATING_RE);
  if (mutatingMatch) {
    return (
      `Blocked by houserules subagent write gate: a subagent may not run ledger command ` +
      `\`${mutatingMatch[1]}\`. Describe the issue and let the caller act on it.\n`
    );
  }

  if (CHANGESET_WRITE_RE.test(cmd)) {
    return (
      'Blocked by houserules subagent write gate: a subagent may not author a changeset. ' +
      'Changesets are one per feature, not one per incremental change. Describe the ' +
      'change and let the caller record it.\n'
    );
  }

  if (DIRECT_EDIT_RE.test(cmd) || REDIRECT_RE.test(cmd)) {
    return (
      'Blocked by houserules subagent write gate: a subagent may not edit a ledger or ' +
      'changeset file directly.\n'
    );
  }

  return null;
}

function readTranscriptLines(path: string): TranscriptRecord[] {
  const text = readFileSync(path, 'utf8');
  const lines: TranscriptRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as TranscriptRecord);
    } catch {
      // Malformed line: skip it rather than aborting the whole scan.
    }
  }
  return lines;
}

/**
 * Whether the trailing assistant turn among `records` is a subagent sidechain. False when
 * there is no assistant turn at all.
 */
export function isSidechainTurn(records: TranscriptRecord[]): boolean {
  const lastTurn = [...records].reverse().find((r) => r.type === 'assistant');
  return lastTurn?.isSidechain === true;
}

/**
 * Reads `transcriptPath` and applies {@link isSidechainTurn}. Fails open (false) on any
 * transcript that can't be read.
 */
function sidechainTurnFromTranscript(
  transcriptPath: string | undefined,
): boolean {
  if (!transcriptPath) return false;

  try {
    return isSidechainTurn(readTranscriptLines(transcriptPath));
  } catch {
    return false;
  }
}

/**
 * Manual `--diagnose` mode: reads a transcript file and reports whether its trailing turn
 * is a sidechain. Kept for inspecting an old session. The hook never calls it.
 */
function runDiagnose(transcriptPath: string): never {
  const sidechainDetected = sidechainTurnFromTranscript(transcriptPath);
  process.stdout.write(
    `${JSON.stringify({ transcriptPath, sidechainDetected }, null, 2)}\n`,
  );
  process.exit(sidechainDetected ? 0 : 1);
}

function main(): void {
  if (process.argv[2] === '--diagnose') {
    const transcriptPath = process.argv[3];
    if (!transcriptPath) {
      process.stderr.write('--diagnose requires a transcript path\n');
      process.exit(1);
    }
    runDiagnose(transcriptPath);
    return;
  }

  const input = readStdinJson<BashPayload>();
  const cmd = input?.tool_input?.command ?? '';
  if (!cmd) process.exit(0);

  const guardRefusal = guardRefusalFor(cmd, {
    projectDir: process.env.CLAUDE_PROJECT_DIR,
    tempRoots: [tmpdir(), '/tmp'],
  });
  if (guardRefusal) {
    process.stderr.write(guardRefusal);
    process.exit(2);
  }

  const writeGateRefusal = writeGateRefusalFor(cmd);
  if (
    writeGateRefusal &&
    typeof input?.agent_id === 'string' &&
    input.agent_id !== ''
  ) {
    process.stderr.write(writeGateRefusal);
    process.exit(2);
  }

  process.exit(0);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
