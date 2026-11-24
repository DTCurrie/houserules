#!/usr/bin/env node
/**
 * Prints one row per wait in a session's transcripts: session, waiter, awaited event, start, end,
 * seconds, other-work, and charge.
 *
 * Usage: node wait-timeline.mjs [--sessions <sessions.txt>] [--min-seconds <n>] [--json <out>] [<main.jsonl>...]
 *
 * Each positional path is a main transcript `<dir>/<session>.jsonl`. The script also reads every
 * subagent transcript under `<dir>/<session>/subagents/`, workflows included. `--sessions` reads
 * the paths from a baseline `sessions.txt`, the first tab-separated field of each line that is not
 * a `#` comment, and keeps the main transcripts. `--min-seconds` drops waits shorter than n
 * seconds, 30 by default. `--json` also writes
 * `{ "schema": "wait-timeline@2", "waits": [{ "session", "waiter", "awaited", "start", "end", "seconds", "otherWork", "endedBy", "charge" }] }`.
 * Rows are sorted by session, then start.
 *
 * Definitions. A party is one transcript, `main` or a subagent named by its agent id. Its own
 * activity is an assistant record, a tool_result record, or a `stop_hook_summary` or
 * `turn_duration` system record. A compaction record, as `compaction.mjs` defines it, is neither
 * activity nor input. An input is a user record that carries no tool_result: a human
 * prompt, a task notification, a peer message or hand-back, or a coordinator message. A meta user
 * record with no `origin` rides along with the input it follows and never counts on its own.
 *
 * A wait is one of two intervals. An idle wait runs from a party's last activity, with no
 * foreground tool call outstanding, to the input that wakes it, which is the last input before
 * its next assistant record. A blocking wait runs from a foreground tool call to its tool_result
 * when the call is `AskUserQuestion`, an `Agent` call without `run_in_background`, or a Bash
 * command that is a keepalive command as `keepalive.mjs` defines it. A party that never wakes again has no row, because no end
 * is recorded.
 *
 * The awaited event is a short label for what the waiter was blocked on. It equals the event that
 * ended the wait, kept in the JSON as `endedBy`, with one exception. When the wait ended on the
 * waiter's own timer, a `keepalive` or a `sleep`, and the waiter was still owed something at that
 * moment, the awaited event is the owed item instead. Owed items are checked in this order: an
 * agent that reported and that the waiter later sends a message to is owed `finished <agent>`, a
 * background agent spawned or resumed with no report since is owed `report <agent>`, and a
 * background command that is not a keepalive and has not completed is owed `background <task>`.
 * A message to `main` resumes no agent, since `main` is a party that is never owed a report by
 * anyone, so it adds no owed item. The timer label stays only when nothing was owed. The labels:
 * - `report <agent>`: a hand-back, or the result of a foreground `Agent` call.
 * - `finished <agent>`: a task notification saying the agent finished.
 * - `interim <agent>`: a task notification saying the agent waits on its own background work.
 * - `keepalive <task>`: a background command that is a keepalive command as `keepalive.mjs` defines it completed.
 * - `background <task>`: any other background command completed or failed.
 * - `workflow <task>`: a dynamic workflow completed.
 * - `notice <task>`: a task notification of any other kind.
 * - `message <agent>`: a peer message that is not a hand-back.
 * - `coordinator`: a message from the party that spawned this subagent, its brief included.
 * - `user`: a human prompt to main, or the answer to `AskUserQuestion`.
 * - `sleep`: a foreground keepalive command returned.
 * - `harness`: an input with no origin that only the harness writes, such as a hand-back nudge.
 *
 * Other-work is `yes` when an actionable input reached the waiter inside the wait, at least
 * OTHER_WORK_SLACK_SECONDS before it ended, and was not the input that ended it. That input was
 * an unblocked item the waiter could have handled. Actionable inputs are reports, user and
 * coordinator messages, peer messages, background and workflow completions, and a `finished`
 * notice for an agent the waiter later sent a message to, with no new report from that agent in
 * between. Interim notices, keepalive completions, and harness nudges are not actionable. Every
 * other wait is `no`.
 *
 * Charge is `runtime` when `endedBy` is an `interim` label, since those seconds are the awaited
 * worker's own runtime, and `wait` otherwise.
 *
 * Exit codes: 0 printed, 2 bad usage. Reads transcripts only, writes `--json` only. Node builtins
 * only.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isCompactionRecord } from './compaction.mjs';
import { isKeepaliveCommand } from './keepalive.mjs';

const SCHEMA_VERSION = 'wait-timeline@2';
const DEFAULT_MIN_SECONDS = 30;
const OTHER_WORK_SLACK_SECONDS = 5;
/**
 * A human prompt counts as re-sent when the next human prompt, compared after lowercasing and
 * collapsing whitespace, is identical, or both are at least EDIT_PREFIX_CHARS long and share that
 * prefix. A shorter prompt matches only exactly. Two prompts that diverge sooner are separate work.
 */
const EDIT_PREFIX_CHARS = 20;
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_TENTH = 100;
const TENTHS_PER_SECOND = 10;
const EXIT_USAGE = 2;
const INTERIM_PREFIX = 'interim ';
const TURN_ENDING_TOOL = 'SubagentHandback';
const ACTIVITY_SUBTYPES = new Set(['stop_hook_summary', 'turn_duration']);
const NOT_ACTIONABLE = new Set(['interim', 'keepalive', 'harness', 'notice']);
const MAIN_PARTY = 'main';
const TIMER = Object.freeze({ sleep: 'sleep', keepalive: 'keepalive' });
const OWED_STATE = Object.freeze({
  running: 'running',
  reported: 'reported',
});
const USAGE =
  'usage: node wait-timeline.mjs [--sessions <sessions.txt>] [--min-seconds <n>] [--json <out>] [<main.jsonl>...]';

function usageError(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(EXIT_USAGE);
}

function mainsFromSessionsFile(path) {
  const mains = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const transcript = line.split('\t')[0];
    if (transcript.endsWith('.jsonl') && !transcript.includes('/subagents/'))
      mains.push(transcript);
  }
  return mains;
}

function parseArgs(argv) {
  const options = {
    sessions: null,
    minSeconds: DEFAULT_MIN_SECONDS,
    json: null,
    mains: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sessions' || arg === '--min-seconds' || arg === '--json') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        usageError(`${arg} needs a value`);
      i += 1;
      if (arg === '--sessions') options.sessions = value;
      else if (arg === '--json') options.json = value;
      else {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 0)
          usageError(`--min-seconds takes a number, got ${value}`);
        options.minSeconds = seconds;
      }
    } else if (arg.startsWith('--')) {
      usageError(`unknown flag ${arg}`);
    } else {
      options.mains.push(arg);
    }
  }
  if (options.sessions)
    options.mains.push(...mainsFromSessionsFile(options.sessions));
  if (options.mains.length === 0) usageError('no main transcript given');
  return options;
}

function readRecords(path) {
  const records = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn last line from a live session is skipped.
    }
  }
  return records;
}

function subagentTranscripts(mainPath) {
  const root = join(
    dirname(mainPath),
    basename(mainPath, '.jsonl'),
    'subagents',
  );
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^agent-.+\.jsonl$/.test(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

function contentBlocks(record) {
  const content = record.message?.content;
  return Array.isArray(content) ? content : [];
}

function contentText(record) {
  const content = record.message?.content;
  if (typeof content === 'string') return content;
  return contentBlocks(record)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

function isToolResult(record) {
  return contentBlocks(record).some((block) => block.type === 'tool_result');
}

function tagContent(text, name) {
  // Lazy and not `[^<]*`: an agent description inside `<summary>` may itself hold a `<`.
  const match = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? match[1].trim() : null;
}

/**
 * Classifies one input record as `{ kind, subject, actionable }`, or null for a meta record with
 * no origin, which rides along with the input before it. `commands` maps a tool_use id and a
 * background task id to the Bash command that started it.
 */
function classifyInput(record, isMain, commands) {
  const origin = record.origin;
  if (!origin) {
    if (record.isMeta) return null;
    const text = contentText(record);
    if (/^\[handback-[a-z-]+\]/.test(text))
      return { kind: 'harness', subject: null };
    return { kind: isMain ? 'user' : 'coordinator', subject: null };
  }
  if (origin.kind === 'human') return { kind: 'user', subject: null };
  if (origin.kind === 'coordinator')
    return { kind: 'coordinator', subject: null };
  if (origin.kind === 'peer') {
    return {
      kind: origin.handback ? 'report' : 'message',
      subject: origin.from ?? null,
    };
  }
  if (origin.kind === 'task-notification') {
    const text = contentText(record);
    const taskId = tagContent(text, 'task-id');
    const summary = tagContent(text, 'summary') ?? '';
    if (/^Agent .* finished$/.test(summary))
      return { kind: 'finished', subject: taskId };
    if (/^Agent .* waiting on its own background work$/.test(summary)) {
      return { kind: 'interim', subject: taskId };
    }
    if (/^Background command /.test(summary)) {
      const command =
        commands.get(tagContent(text, 'tool-use-id')) ?? commands.get(taskId);
      const kind =
        command !== undefined && isKeepaliveCommand(command)
          ? TIMER.keepalive
          : 'background';
      return { kind, subject: taskId };
    }
    if (/^Dynamic workflow /.test(summary))
      return { kind: 'workflow', subject: taskId };
    return { kind: 'notice', subject: taskId };
  }
  return { kind: 'harness', subject: null };
}

const label = (input) =>
  input.subject ? `${input.kind} ${input.subject}` : input.kind;

const roundToTenths = (milliseconds) =>
  Math.round(milliseconds / MILLISECONDS_PER_TENTH) / TENTHS_PER_SECOND;

/**
 * Indexes the commands behind background task ids, and the SendMessage calls that show a
 * `finished` notice was owed a message.
 */
function indexCommandsAndSends(timed) {
  const commands = new Map();
  const sends = [];
  for (const record of timed) {
    for (const block of contentBlocks(record)) {
      if (record.type === 'assistant' && block.type === 'tool_use') {
        if (block.name === 'Bash')
          commands.set(block.id, String(block.input?.command ?? ''));
        if (block.name === 'SendMessage' && block.input?.to) {
          sends.push({ at: Date.parse(record.timestamp), to: block.input.to });
        }
      }
    }
    const taskId = record.toolUseResult?.backgroundTaskId;
    if (taskId) {
      const result = contentBlocks(record).find(
        (block) => block.type === 'tool_result',
      );
      if (result && commands.has(result.tool_use_id)) {
        commands.set(taskId, commands.get(result.tool_use_id));
      }
    }
  }
  return { commands, sends };
}

function collectInputs(timed, isMain, commands) {
  const inputs = [];
  let assistantCount = 0;
  for (const record of timed) {
    if (record.type === 'assistant') assistantCount++;
    if (record.type !== 'user' || isToolResult(record)) continue;
    if (isCompactionRecord(record)) continue;
    const input = classifyInput(record, isMain, commands);
    if (input)
      inputs.push({
        ...input,
        at: Date.parse(record.timestamp),
        record,
        assistantCount,
      });
  }
  markResentPrompts(inputs);
  return inputs;
}

const normalizePrompt = (record) =>
  contentText(record).toLowerCase().replace(/\s+/g, ' ').trim();

function isResend(earlier, later) {
  if (earlier.length === 0 || later.length === 0) return false;
  if (earlier === later) return true;
  const shorter = Math.min(earlier.length, later.length);
  if (shorter < EDIT_PREFIX_CHARS) return false;
  return (
    earlier.slice(0, EDIT_PREFIX_CHARS) === later.slice(0, EDIT_PREFIX_CHARS)
  );
}

/**
 * The later prompt replaces the earlier one when it branches from the same parent record, or
 * when no assistant record lies between them, so the earlier one was never answered.
 */
function replacesUnanswered(earlier, later) {
  const parent = earlier.record.parentUuid;
  if (parent !== undefined && parent === later.record.parentUuid) return true;
  return earlier.assistantCount === later.assistantCount;
}

/**
 * Sets `isResent` on each `user` input that the next `user` input repeats or edits.
 */
function markResentPrompts(inputs) {
  const prompts = inputs.filter((input) => input.kind === 'user');
  for (let index = 0; index + 1 < prompts.length; index++) {
    if (
      replacesUnanswered(prompts[index], prompts[index + 1]) &&
      isResend(
        normalizePrompt(prompts[index].record),
        normalizePrompt(prompts[index + 1].record),
      )
    )
      prompts[index].isResent = true;
  }
}

/**
 * A `finished` notice for an agent owes the waiter a message when the waiter later sends that
 * agent one, with no new report from it in between.
 */
function makeMessageOwedCheck(sends, inputs) {
  return (agentId, after) =>
    sends.some(
      (send) =>
        send.to === agentId &&
        send.at > after &&
        !inputs.some(
          (other) =>
            other.kind === 'report' &&
            other.subject === agentId &&
            other.at > after &&
            other.at < send.at,
        ),
    );
}

function makeActionableCheck(isMessageOwed) {
  return (input) => {
    if (input.isResent) return false;
    if (input.kind === 'finished')
      return isMessageOwed(input.subject, input.at);
    return !NOT_ACTIONABLE.has(input.kind);
  };
}

function makeEmitter({ waits, session, waiter, owed, isActionable }) {
  return (start, end, endedBy, pending, waking) => {
    if (end < start) return;
    const hasOtherWork = pending.some(
      (input) =>
        input !== waking &&
        input.at >= start &&
        input.at <= end - OTHER_WORK_SLACK_SECONDS * MILLISECONDS_PER_SECOND &&
        isActionable(input),
    );
    const isOwnTimer =
      endedBy === TIMER.sleep || endedBy.startsWith(`${TIMER.keepalive} `);
    waits.push({
      session,
      waiter,
      awaited: (isOwnTimer && owed.firstAt(end)) || endedBy,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      seconds: roundToTenths(end - start),
      otherWork: hasOtherWork ? 'yes' : 'no',
      endedBy,
      charge: endedBy.startsWith(INTERIM_PREFIX) ? 'runtime' : 'wait',
    });
  };
}

/** Registers each tool call of an assistant record as outstanding. */
function recordToolUses(record, at, outstanding, owed) {
  for (const block of contentBlocks(record)) {
    if (block.type !== 'tool_use') continue;
    outstanding.set(block.id, { at, block });
    if (block.name === 'SendMessage' && block.input?.to)
      owed.resumed(block.input.to);
  }
}

/**
 * Closes the outstanding calls a tool-result record answers, emitting a wait for each blocking one.
 * @returns Whether one of them was the turn-ending tool.
 */
function settleToolResults(record, at, outstanding, owed, emit, pending) {
  let endsTurn = false;
  for (const block of contentBlocks(record)) {
    if (block.type !== 'tool_result') continue;
    const call = outstanding.get(block.tool_use_id);
    if (!call) continue;
    outstanding.delete(block.tool_use_id);
    if (call.block.name === TURN_ENDING_TOOL) endsTurn = true;
    owed.started(call.block, record.toolUseResult);
    const endedBy = blockingLabel(call.block, record);
    if (endedBy) emit(call.at, at, endedBy, pending, null);
  }
  return endsTurn;
}

/**
 * Walks the party's records in file order and emits each wait it finds.
 */
function walkRecords(timed, inputs, owed, emit) {
  const outstanding = new Map();
  const inputByRecord = new Map(inputs.map((input) => [input.record, input]));
  let lastActivity = null;
  let pending = [];
  for (const record of timed) {
    const at = Date.parse(record.timestamp);
    if (Number.isNaN(at) || isCompactionRecord(record)) continue;
    if (record.type === 'assistant') {
      if (
        pending.length > 0 &&
        outstanding.size === 0 &&
        lastActivity !== null
      ) {
        const waking = pending[pending.length - 1];
        emit(lastActivity, waking.at, label(waking), pending, waking);
      }
      recordToolUses(record, at, outstanding, owed);
      lastActivity = at;
      pending = [];
    } else if (record.type === 'user' && isToolResult(record)) {
      const endsTurn = settleToolResults(
        record,
        at,
        outstanding,
        owed,
        emit,
        pending,
      );
      lastActivity = endsTurn ? at : null;
      pending = [];
    } else if (record.type === 'user') {
      const input = inputByRecord.get(record);
      if (input) {
        pending.push(input);
        owed.heard(input);
      }
    } else if (
      record.type === 'system' &&
      ACTIVITY_SUBTYPES.has(record.subtype)
    ) {
      lastActivity = at;
    }
  }
}

/**
 * Reads one transcript and returns its waits, before the `--min-seconds` filter.
 */
function waitsOf(records, session, waiter) {
  const timed = records.filter(
    (record) => typeof record.timestamp === 'string',
  );
  const { commands, sends } = indexCommandsAndSends(timed);
  const inputs = collectInputs(timed, waiter === MAIN_PARTY, commands);
  const isMessageOwed = makeMessageOwedCheck(sends, inputs);
  const owed = createOwedTracker(isMessageOwed);
  const waits = [];
  const emit = makeEmitter({
    waits,
    session,
    waiter,
    owed,
    isActionable: makeActionableCheck(isMessageOwed),
  });
  walkRecords(timed, inputs, owed, emit);
  return waits;
}

/**
 * Tracks what a party is owed as its records are walked: background agents it spawned or resumed
 * that have not reported, agents that reported and will be sent a message once they finish, and
 * background commands other than keepalives that have not completed. `isMessageOwed(agentId, at)`
 * says whether the party sends that agent a message after `at`.
 */
function createOwedTracker(isMessageOwed) {
  const agents = new Map();
  const commands = new Set();
  return {
    started(block, toolUseResult) {
      if (block.name === 'Agent' && toolUseResult?.agentId) {
        if (toolUseResult.isAsync || block.input?.run_in_background) {
          agents.set(toolUseResult.agentId, OWED_STATE.running);
        }
      }
      const taskId = toolUseResult?.backgroundTaskId;
      if (
        block.name === 'Bash' &&
        taskId &&
        !(
          block.input?.run_in_background &&
          isKeepaliveCommand(String(block.input?.command ?? ''))
        )
      ) {
        commands.add(taskId);
      }
    },
    resumed(agentId) {
      if (agentId === MAIN_PARTY) return;
      agents.set(agentId, OWED_STATE.running);
    },
    heard(input) {
      if (input.kind === 'report')
        agents.set(input.subject, OWED_STATE.reported);
      if (input.kind === 'finished') agents.delete(input.subject);
      if (input.kind === 'background' || input.kind === TIMER.keepalive)
        commands.delete(input.subject);
    },
    /** The label of the first item owed at `end`, a `finished` before a `report` before a command. */
    firstAt(end) {
      for (const [agentId, state] of agents) {
        if (state === OWED_STATE.reported && isMessageOwed(agentId, end))
          return `finished ${agentId}`;
      }
      for (const [agentId, state] of agents) {
        if (state === OWED_STATE.running) return `report ${agentId}`;
      }
      for (const taskId of commands) return `background ${taskId}`;
      return null;
    },
  };
}

/**
 * The awaited label of a foreground tool call that blocks on something outside the party, or
 * null for a call that is the party's own work.
 */
function blockingLabel(block, resultRecord) {
  if (block.name === 'AskUserQuestion') return 'user';
  if (block.name === 'Agent' && !block.input?.run_in_background) {
    const agentId = resultRecord.toolUseResult?.agentId;
    if (resultRecord.toolUseResult?.isAsync) return null;
    return agentId ? `report ${agentId}` : 'report';
  }
  if (block.name === 'Bash' && !block.input?.run_in_background) {
    if (isKeepaliveCommand(String(block.input?.command ?? '')))
      return TIMER.sleep;
  }
  return null;
}

function collectWaits(options) {
  const waits = [];
  for (const mainPath of options.mains) {
    if (!existsSync(mainPath)) {
      console.error(`missing transcript: ${mainPath}`);
      continue;
    }
    const session = basename(mainPath, '.jsonl');
    waits.push(...waitsOf(readRecords(mainPath), session, MAIN_PARTY));
    for (const path of subagentTranscripts(mainPath)) {
      const waiter = basename(path, '.jsonl').replace(/^agent-/, '');
      waits.push(...waitsOf(readRecords(path), session, waiter));
    }
  }
  return waits
    .filter((wait) => wait.seconds >= options.minSeconds)
    .sort((a, b) =>
      a.session === b.session
        ? a.start.localeCompare(b.start)
        : a.session.localeCompare(b.session),
    );
}

function formatTable(waits) {
  const header = [
    'session',
    'waiter',
    'awaited',
    'start',
    'end',
    'seconds',
    'other-work',
    'charge',
  ];
  const rows = waits.map((wait) => [
    wait.session,
    wait.waiter,
    wait.awaited,
    wait.start,
    wait.end,
    wait.seconds.toFixed(1),
    wait.otherWork,
    wait.charge,
  ]);
  const widths = header.map((name, column) =>
    Math.max(name.length, ...rows.map((row) => row[column].length)),
  );
  const format = (row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]))
      .join('  ')
      .trimEnd();
  return [format(header), ...rows.map(format)].join('\n');
}

function writeJson(path, waits) {
  writeFileSync(
    path,
    `${JSON.stringify({ schema: SCHEMA_VERSION, waits }, null, 2)}\n`,
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const waits = collectWaits(options);
  console.log(formatTable(waits));
  if (options.json) writeJson(options.json, waits);
}

main();
