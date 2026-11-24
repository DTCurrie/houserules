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
 * Mod guard: a command that writes into a Claude Code mod directory, by an output redirection,
 * `tee`, or `cp`/`mv`/`install`/`ln`, is refused outside `default` and `acceptEdits` modes,
 * from any thread. It applies the rule `guard-mods` applies to Write and Edit, and fails open.
 *
 * `--diagnose <transcript-path>` is a separate, manually-run mode (never invoked by the
 * hook itself) kept for inspecting an old session. It reports whether the transcript's
 * trailing turn is a sidechain, printing JSON and exiting 0 when it is, 1 when it is not.
 * It says nothing about what the hook decided at the time.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { GUARD_DEFAULTS, loadConfigSafe } from '@houserules/payload/config';
import { readStdinJson } from '@houserules/payload/proc';

interface BashPayload {
  cwd?: string;
  permission_mode?: string;
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
const STASH_MUTATING = String.raw`stash\b(?=\s*(?:$|[\n;&|])|\s+-|\s+(?:push|save|pop|apply|drop|clear|branch|create|store)\b)`;
// A subcommand the shell computes, as in `git $(echo commit)`, could be any guarded one.
// A lone `-C` or `-c` takes the substitution as its value, so that position is not the subcommand.
const COMPUTED_SUBCOMMAND = String.raw`(?<!\s-[Cc]\s)\$\(\)`;

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
  custom?: { pattern: string; message?: string }[];
}): DenyRule[] {
  const gitRule = (
    sub: string,
    msg: string,
    exemptable: boolean,
  ): DenyRule => ({
    re: new RegExp(
      `${CMD_START}git\\s+${GIT_FLAGS}(?:${sub}|${COMPUTED_SUBCOMMAND})`,
    ),
    msg,
    exemptable,
    scope: 'segment',
  });

  const deny: DenyRule[] = [];
  if (guard.gitCommit) {
    deny.push(
      gitRule(
        String.raw`commit\b`,
        "git commit is the user's to run. Describe what's staged and stop.",
        true,
      ),
    );
  }
  if (guard.gitPush) {
    deny.push(
      gitRule(String.raw`push\b`, "git push is the user's to run.", false),
    );
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
      re: new RegExp(
        `${CMD_START}git\\s+${GIT_FLAGS}(?:${GIT_DISCARD}|${COMPUTED_SUBCOMMAND})`,
      ),
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
        msg: customMessageOf(rule),
        exemptable: false,
        scope: 'command',
      });
    } catch {
      // Invalid user regex: skip the rule rather than break every Bash call.
    }
  }
  return deny;
}

/** A hand-edited rule can reach the guard with no message, so the refusal names the field. */
function customMessageOf(rule: { pattern: string; message?: string }): string {
  if (typeof rule.message === 'string' && rule.message !== '') {
    return rule.message;
  }
  return `the guard.custom rule for pattern \`${rule.pattern}\` has no \`message\` field. Add one to .claude/houserules.config.json so the refusal says why.`;
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
      isExempt ??= isThrowawayCommand(cmd, tokenized, throwaway);
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

/** The `separator` of a command that the end of the input closed. */
const END_SEPARATOR = 'end';

/** One simple command, its words after quote removal, joined for the segment rules. */
interface CommandSegment {
  text: string;
  /** The words after quote removal, with any wrapper such as `env` or `sudo` removed. */
  words: string[];
  /** The operator that ended the command: `&&`, `||`, `;`, `|`, `&`, `\n`, a paren, or `end`. */
  separator: string;
  /** Whether it runs from a substitution, a heredoc expansion, `sh -c`, or `eval`. */
  isNested: boolean;
  /** The targets of its output redirections (`>`, `>>`, `>|`, `&>`), after quote removal. */
  redirectTargets: string[];
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
  /** Where the current word's output redirection target begins, or null when it has none. */
  private redirectStart: number | null = null;
  private isRedirectTargetNext = false;
  private redirectTargets: string[] = [];

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
        this.endSegment('\n');
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
    if (char === '>') return this.readOutputRedirect();
    this.append(char);
    this.pos++;
  }

  /** Reads an output redirection operator and notes where its target begins. `>&` has none. */
  private readOutputRedirect(): void {
    const next = this.source[this.pos + 1];
    const operator = next === '>' || next === '|' ? `>${next}` : '>';
    this.append(operator);
    this.pos += operator.length;
    if (this.source[this.pos] !== '&') this.redirectStart = this.word.length;
  }

  private fail(reason: string): void {
    if (!this.isLenient) throw new ShellSyntaxError(reason);
  }

  private append(text: string): void {
    this.word += text;
    this.hasWord = true;
  }

  private endWord(): void {
    if (this.hasWord) {
      this.noteRedirectTarget();
      this.words.push(this.word);
    }
    this.word = '';
    this.hasWord = false;
    this.redirectStart = null;
  }

  /** Records the word just ended as a redirection target, or arms the next word as one. */
  private noteRedirectTarget(): void {
    if (this.isRedirectTargetNext) {
      this.isRedirectTargetNext = false;
      this.redirectTargets.push(this.word);
      return;
    }
    if (this.redirectStart === null) return;
    const target = this.word.slice(this.redirectStart);
    if (target === '') this.isRedirectTargetNext = true;
    else this.redirectTargets.push(target);
  }

  private breakSegment(): void {
    const char = this.source[this.pos] ?? '';
    const isDoubled =
      (char === '&' || char === '|') && this.source[this.pos + 1] === char;
    const separator = isDoubled ? char + char : char;
    this.endSegment(separator);
    this.pos += separator.length;
  }

  private endSegment(separator = END_SEPARATOR): void {
    this.endWord();
    const words = unwrapCommand(commandWordsOf(this.words));
    const redirectTargets = this.redirectTargets;
    this.words = [];
    this.redirectTargets = [];
    this.isRedirectTargetNext = false;
    if (words.length === 0) return;
    this.out.push({
      text: words.map(segmentWord).join(' '),
      words,
      separator,
      isNested: this.depth > 0,
      redirectTargets,
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

// Options of a wrapper that consume the next word as their value.
const WRAPPER_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  sudo: new Set(['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U', '-D', '-T']),
  doas: new Set(['-u', '-C']),
  exec: new Set(['-a']),
  nice: new Set(['-n']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-s', '-E', '-d', '-a', '-J']),
  command: new Set(),
  nohup: new Set(),
};

/**
 * `words` with the wrappers that only run the next command removed, so `env FOO=1 sudo git
 * commit` reads as `git commit`. A wrapper that looks a command up instead of running it,
 * such as `command -v`, is left as it is.
 */
function unwrapCommand(words: string[]): string[] {
  let rest = words;
  for (;;) {
    const [program = '', ...args] = rest;
    const valueOptions = WRAPPER_VALUE_OPTIONS[basename(program)];
    if (valueOptions === undefined) return rest;
    let index = 0;
    while (index < args.length) {
      const arg = args[index] ?? '';
      if (arg === '--') {
        index++;
        break;
      }
      const isEnvAssignment = program === 'env' && ASSIGNMENT_RE.test(arg);
      if (!arg.startsWith('-') && !isEnvAssignment) break;
      index += valueOptions.has(arg) ? 2 : 1;
      if (program === 'command' && /^-[vV]/.test(arg)) return rest;
    }
    const inner = commandWordsOf(args.slice(index));
    if (inner.length === 0) return rest;
    rest = inner;
  }
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
const DIRECTORY_CHANGE_WORDS = new Set(['cd', 'pushd', 'popd']);
// No quotes, `$`, `~`, globs, or backslashes, so the shell cannot expand it into another path.
const PLAIN_ABSOLUTE_PATH_RE = /^\/[\w./@+,%=:-]*$/;
const SUBCOMMAND_RE = /^[a-z][a-z-]*$/;

interface ProjectIdentity {
  dir: string;
  commonDir: string;
  remoteUrls: Set<string>;
}

/** Whether `cmd` names exactly one target and that target is a throwaway fixture repo. */
function isThrowawayCommand(
  cmd: string,
  tokenized: TokenizedCommand,
  context: ThrowawayContext,
): boolean {
  const target = targetOf(cmd, tokenized);
  if (!target || !context.projectDir) return false;
  try {
    return isThrowawayRepo(target, context.projectDir, context.tempRoots);
  } catch {
    return false;
  }
}

/**
 * The one directory every git call in `cmd` runs in, from a leading `cd <path> &&` or from
 * the same `-C <path>` on every git call. Reads the commands from the same tokenizer as the
 * guard rules, so a separator inside a quote is data. Null for any form the resolver does
 * not recognize.
 */
function targetOf(cmd: string, tokenized: TokenizedCommand): string | null {
  if (UNRECOGNIZED_TEXT_RE.test(cmd) || !tokenized.isClean) return null;
  const [first, ...later] = tokenized.segments;
  if (
    first === undefined ||
    tokenized.segments.some((segment) => segment.isNested)
  ) {
    return null;
  }
  const isLeadingCd = first.words[0] === 'cd' && first.separator === '&&';
  const cdTarget = isLeadingCd ? first.words[1] : undefined;
  if (isLeadingCd && !isPlainCdTarget(first.words, cdTarget)) return null;
  const rest = isLeadingCd ? later : tokenized.segments;
  if (
    rest.some((segment) => DIRECTORY_CHANGE_WORDS.has(segment.words[0] ?? ''))
  ) {
    return null;
  }

  const cTargets = new Set<string>();
  for (const segment of rest) {
    if (segment.words[0] !== 'git') continue;
    const invocation = gitInvocationOf(segment.words);
    if (!invocation) return null;
    const hasDashCTarget = invocation.cTarget !== undefined;
    if (hasDashCTarget === (cdTarget !== undefined)) return null;
    if (invocation.cTarget) cTargets.add(invocation.cTarget);
  }
  if (cdTarget !== undefined) return cdTarget;
  return cTargets.size === 1 ? ([...cTargets][0] ?? null) : null;
}

function isPlainCdTarget(
  words: string[],
  target: string | undefined,
): target is string {
  return (
    words.length === 2 &&
    target !== undefined &&
    PLAIN_ABSOLUTE_PATH_RE.test(target)
  );
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
 * The checks run over the raw command and over each tokenized segment, so a wrapper such as
 * `env` or `sudo`, a substitution, or `bash -c` cannot hide a ledger or changeset write. The
 * overwhelming majority of Bash calls are answered before the payload's identity is looked at.
 */
export function writeGateRefusalFor(cmd: string): string | null {
  const texts = [
    cmd,
    ...tokenizeCommand(cmd).segments.map((segment) => segment.text),
  ];
  for (const text of texts) {
    const refusal = writeGateRefusalIn(text);
    if (refusal) return refusal;
  }
  return null;
}

function writeGateRefusalIn(cmd: string): string | null {
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

/**
 * Where the mod guard looks for mods. This and the detection below mirror `guard-mods.mts`,
 * since `docs/payload.md` provides no way for one payload script to import another.
 */
export interface ModLocations {
  configDir: string;
  pluginDirs: string[];
}

// Claude Code prompts for a write to a mod directory in these modes, so the user decides.
const MOD_PROMPTED_MODES = new Set(['default', 'acceptEdits']);
// Programs whose last operand is the path they write, with each source landing inside it when it is a directory.
const COPY_PROGRAMS = new Set(['cp', 'mv', 'install', 'ln']);
const REDIRECTION_WORD_RE = /^(?:\d+|&)?(?:>>?|>\||>&|<<<|<&|<)/;
const HOME_PREFIX_RE = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;

/** The mod locations `env` names, defaulting the config directory to `~/.claude`. */
function modLocationsFrom(env: NodeJS.ProcessEnv): ModLocations {
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const pluginDirs = (env.CLAUDE_CODE_PLUGIN_DIRS ?? '')
    .split(delimiter)
    .filter((dir) => dir !== '');
  return { configDir, pluginDirs };
}

/** `path` with every symlink followed, a missing tail appended to its deepest existing ancestor. */
function realPathOf(path: string): string {
  const missingTail: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...missingTail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missingTail.unshift(basename(current));
      current = parent;
    }
  }
}

function isInsideDir(dir: string, target: string): boolean {
  const relativePath = relative(dir, target);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

function declaresModules(hooksJson: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(hooksJson, 'utf8')) as {
      modules?: unknown;
    };
    return Array.isArray(parsed.modules);
  } catch {
    return false;
  }
}

/** The nearest ancestor of `target` laid out as a mod, or null when none is. */
function enclosingModDir(target: string): string | null {
  let dir = dirname(target);
  for (;;) {
    if (
      existsSync(join(dir, '.claude-plugin', 'plugin.json')) &&
      declaresModules(join(dir, 'hooks', 'hooks.json'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The mod directory `target` resolves into, or null when it resolves into none. */
function modDirHolding(target: string, locations: ModLocations): string | null {
  const roots = [
    join(locations.configDir, 'dev-mods'),
    ...locations.pluginDirs,
  ];
  const match = roots.find((root) => isInsideDir(realPathOf(root), target));
  return match ?? enclosingModDir(target);
}

/** `words` without their redirection operators and the words those operators take. */
function operandsOf(words: string[]): string[] {
  const operands: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? '';
    const redirection = REDIRECTION_WORD_RE.exec(word);
    if (redirection === null) operands.push(word);
    else if (redirection[0] === word) index++;
  }
  return operands.filter((operand) => !operand.startsWith('-'));
}

/** The paths one simple command writes: its redirection targets, `tee`'s files, a copy's destination. */
function writeTargetsOf(segment: CommandSegment): string[] {
  const [program = '', ...rest] = segment.words;
  const name = basename(program);
  if (name === 'tee') return [...segment.redirectTargets, ...operandsOf(rest)];
  if (!COPY_PROGRAMS.has(name)) return segment.redirectTargets;
  const operands = operandsOf(rest);
  const destination = operands[operands.length - 1];
  const sources = operands.slice(0, -1);
  if (sources.length === 0 || destination === undefined) {
    return segment.redirectTargets;
  }
  const landings = sources.map((source) => join(destination, basename(source)));
  return [...segment.redirectTargets, destination, ...landings];
}

function expandHome(path: string): string {
  return path.replace(HOME_PREFIX_RE, () => homedir());
}

/**
 * The stderr message refusing a Bash command that writes into a Claude Code mod directory,
 * or null when it writes into none or `permissionMode` puts each such write to the user. The
 * same rule `guard-mods` applies to Write and Edit, read from the command's redirections,
 * `tee`, and `cp`/`mv`/`install`/`ln`, with each `cd` before them followed.
 */
export function modWriteRefusalFor(
  cmd: string,
  permissionMode: string | undefined,
  cwd: string,
  locations: ModLocations,
): string | null {
  if (permissionMode && MOD_PROMPTED_MODES.has(permissionMode)) return null;
  let base = cwd;
  for (const segment of tokenizeCommand(cmd).segments) {
    const [program, directory] = segment.words;
    if (program === 'cd') {
      if (directory !== '-') base = resolve(base, expandHome(directory ?? '~'));
      continue;
    }
    for (const path of writeTargetsOf(segment)) {
      const target = realPathOf(resolve(base, expandHome(path)));
      const modDir = modDirHolding(target, locations);
      if (!modDir) continue;
      return (
        `houserules mod guard: ${target} is inside the Claude Code mod directory ${modDir}. ` +
        `A mod loads without asking in ${permissionMode ?? 'this'} mode and runs ahead of every ` +
        `PreToolUse hook, so this command was not run. Tell the user what the mod should do ` +
        `and let them write it, or ask them to switch to default or acceptEdits mode, where ` +
        `each mod file write is put to them.\n`
      );
    }
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

/** The mod-dir refusal for `cmd`, or null. Fails open, as guard-mods does on any error. */
function modRefusalOrNull(
  cmd: string,
  input: BashPayload | null | undefined,
): string | null {
  try {
    return modWriteRefusalFor(
      cmd,
      input?.permission_mode,
      input?.cwd ?? process.cwd(),
      modLocationsFrom(process.env),
    );
  } catch {
    return null;
  }
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

  const modRefusal = modRefusalOrNull(cmd, input);
  if (modRefusal) {
    process.stderr.write(modRefusal);
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
