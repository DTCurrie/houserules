#!/usr/bin/env node
/**
 * Classifies the tool calls in Claude Code transcripts into seven waste kinds and prints one
 * `waste-audit@3` JSON object on stdout.
 *
 * Usage: node waste-audit.mjs [--ablate] [--sessions <sessions.txt>] [<transcript.jsonl> ...]
 *
 * `--sessions` reads the baseline list: `#` lines are comments, every other line is
 * `path<TAB>bytes<TAB>last-write[<TAB>note]`. A file named `journal.jsonl` is skipped.
 * Cost is per API request, deduplicated by `message.id`, priced with the report command's price
 * table, and split evenly across the tool_use blocks of the request. A call's wall seconds are
 * its request's span split the same way. A request's span starts at the latest `api-request`
 * record after its latest user record, or at that user record when no `api-request` with a
 * parseable timestamp follows it, and ends at its last tool_result. Totals cover only requests
 * that carry a tool call.
 * A call belongs to at most one kind. Kinds claim calls in CLAIM_ORDER, most specific first, and
 * an episode keeps only the calls no earlier kind claimed. A subagent transcript's `small-agent`
 * episode stays outside that order, since its calls live in the subagent's own file.
 * The `small-agent` kind entry, and no other, carries `agentTypes`: one
 * `{ agentType, count, calls, wallSeconds, costUsd }` per distinct agent type, `null` apart,
 * ranked by cost. The type is the `agentType` of the `.meta.json` beside each transcript whose
 * path has a `subagents` segment.
 * `--ablate` adds the `ablation` key: one `{ rule, kinds }` entry per correction rule, in the
 * order `compaction-ask`, `span-clock`, `terminal-handback`, `reread-reset`,
 * `rerun-classifier-blocked`, `rerun-keepalive`, `acceptance-claims`, and `all`, which turns
 * every rule off. Each `kinds` element holds a kind's figures and pointers recomputed with that
 * rule off, and no `rule` or `agentTypes` field. Without the flag the output has no `ablation` key.
 *
 * Exit codes: 0 printed, 2 no input. Reads the named files and each subagent transcript's
 * `.meta.json` sibling only, and writes stdout only.
 * Node builtins, `packages/cli/dist/`, and the sibling `compaction.mjs` and `keepalive.mjs` only.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupModelPrice } from '../../../packages/cli/dist/commands/report/model-prices.js';
import { isCompactionRecord } from './compaction.mjs';
import { isKeepaliveCommand } from './keepalive.mjs';

const SCHEMA_VERSION = 'waste-audit@3';

const CACHE_WRITE_5M_MULTIPLE = 1.25;
const CACHE_WRITE_1H_MULTIPLE = 2;
const TOKENS_PER_MILLION = 1_000_000;
const COST_DECIMALS = 6;
const WALL_DECIMALS = 3;

/** A request-to-act gap shorter than this many calls is ordinary exploration. */
const ASK_TO_ACT_MIN_CALLS = 8;
/** Calls after a wireit skip line in which a log read counts as a re-check. */
const WIREIT_FOLLOW_WINDOW = 3;
/** A subagent transcript with fewer tool calls than this was not worth a spawn. */
const SMALL_AGENT_MAX_CALLS = 5;
/** Non-writing calls between the plan-project fire and the first plan write that count as waste. */
const PLAN_READ_MIN_CALLS = 10;
/** A command shorter than this is too generic to match verbatim inside a report. */
const MIN_VERBATIM_COMMAND_LENGTH = 12;
const MILLISECONDS_PER_SECOND = 1000;
const READ_KEY_SEPARATOR = '\u0000';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const REPORT_TOOLS = new Set(['Agent', 'Task', 'SendMessage']);
const SPAWN_TOOLS = new Set(['Agent', 'Task']);
/** A subagent's last call when it is one of these hands its result back and is not work. */
const TERMINAL_TOOLS = new Set(['SubagentHandback', 'StructuredOutput']);
/** The stable opening of the auto mode classifier's result for a Bash call it never ran. */
const CLASSIFIER_NO_VERDICT =
  'The server-side auto mode classifier gave no verdict';
const HANDBACK_MARKER = '[Subagent hand-back]';
/** A single `|` between pipeline stages, not the `||` of an or-list. */
const PIPE = /(?<!\|)\|(?!\|)/;
/** The diagnosis counter's test for a failing run's output. */
const FAILED_RESULT =
  /ℹ fail [1-9]|✖|^\s*not ok|\bFAIL\b|\b[1-9]\d* failed\b|error TS\d+|Exit code [1-9]|AssertionError/m;
/** A line that names the failing test, so a rerun is not needed to find it. */
const NAMED_FAILURE = /^\s*not ok|✖|\bFAIL\b/m;
const WIREIT_SKIP = /Already fresh|Restored from cache/;
const LOG_READ_COMMAND = /\b(?:grep|rg|tail|cat|head)\b/;
const LOG_TARGET = /\.log\b|\.output\b|\/tmp\/|\/tasks\//;
const CHECK_COMMAND =
  /(?:^|[\s&;|(])(?:pnpm|npx|vitest|tsc|eslint|prettier)(?:\s|$)|\bnpm run\b|\bnode --test\b|plan-lint|prose-lint/;
const MUTATING_BASH =
  /\bgit\s+(?:commit|push)\b|\bgh\s+(?:pr|issue)\s+(?:create|edit|comment)\b/;
const ASK_PATTERN =
  /\b(?:commit|push|edit|write|add|fix|implement|update|rename|delete|remove|rewrite|change|create|make|record|scaffold|apply)\b/i;
const NOT_A_REQUEST_PREFIX =
  /^\s*(?:<command-name>|<local-command|<task-notification>|<system-reminder>|\[Request interrupted)/;
const PLAN_COMMAND = /<command-name>\/plan-project<\/command-name>/;
const PLANS_PATH = '.claude/plans/';
const SUBAGENT_PATH = /[\\/]subagents[\\/]/;
const TASK_OUTPUT_PATH = /\/tasks\/[^/]+\.output$/;

const KIND_RULES = {
  'rerun-unchanged':
    "A Bash check command whose normalized text equals an earlier one in the same transcript, with no Write, Edit, or NotebookEdit call between them. A call whose result opens with the auto mode classifier's no-verdict text never ran and counts as neither run, and a keepalive launched with run_in_background never counts.",
  'reread-unchanged':
    'A Read of a file_path already Read with the same offset and limit, with no Write, Edit, or NotebookEdit to that path between them. A compaction boundary clears the Read history, and a path matching /tasks/*.output never counts, since a background task rewrites it.',
  'ask-to-act-gap': `In a main transcript, the calls between a user text message that asks for a change and the first Write, Edit, git commit or push, or gh pr or issue create, edit, or comment after it, when there are at least ${ASK_TO_ACT_MIN_CALLS} of them and no other user text message or compaction arrives first. A compaction summary or continuation message is not an ask.`,
  'acceptance-rerun-after-report': `A Bash command whose text before its first pipe is at least ${MIN_VERBATIM_COMMAND_LENGTH} characters and appears verbatim in the last worker report, run after the report arrived and before the next Agent dispatch. A worker report is an Agent, Task, or SendMessage result, a task notification, or a ${HANDBACK_MARKER} message. Also a rerun of a check command, compared on its text before its first pipe, with no Write, Edit, or NotebookEdit since a failing run of it whose output held no not ok, ✖, or FAIL line.`,
  'grep-after-wireit-skip': `A Bash grep, rg, tail, cat, or head over a log path within ${WIREIT_FOLLOW_WINDOW} calls after a Bash result that held a wireit skip line.`,
  'small-agent': `A subagent transcript that made fewer than ${SMALL_AGENT_MAX_CALLS} tool calls, not counting a final SubagentHandback or StructuredOutput call. Each episode carries the agentType from the .meta.json beside the transcript, or null.`,
  'plan-read-before-write': `In a transcript where plan-project hasPlanProjectFired, the non-writing calls between that fire and the first Write or Edit under ${PLANS_PATH}, when there are at least ${PLAN_READ_MIN_CALLS} of them.`,
};

export const KIND_NAMES = Object.keys(KIND_RULES);

/** The correction rules `--ablate` turns off one at a time. */
export const RULE_IDS = [
  'compaction-ask',
  'span-clock',
  'terminal-handback',
  'reread-reset',
  'rerun-classifier-blocked',
  'rerun-keepalive',
  'acceptance-claims',
];
const ALL_RULES = 'all';
/** The `ablation` entries in print order: each rule alone, then every rule at once. */
export const ABLATION_IDS = [...RULE_IDS, ALL_RULES];
const NO_RULES_OFF = new Set();

const normalize = (text) => text.replace(/\s+/g, ' ').trim();

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function requestCost(usage, model, unpriced) {
  const price = model ? lookupModelPrice(model) : undefined;
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const written = usage?.cache_creation_input_tokens ?? 0;
  const write1h = usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = Math.max(0, written - write1h);
  let cost = 0;
  if (price) {
    cost =
      (input * price.input +
        output * price.output +
        cacheRead * price.cacheRead +
        write5m * price.input * CACHE_WRITE_5M_MULTIPLE +
        write1h * price.input * CACHE_WRITE_1H_MULTIPLE) /
      TOKENS_PER_MILLION;
  } else if (usage && model) {
    unpriced.add(model);
  }
  return {
    cost,
    inputTokens: input + cacheRead + written,
    outputTokens: output,
  };
}

/** Reads one transcript into a call list, a request map, and an ordered event list. */
function parseTranscript(text, off) {
  const isClockOn = !off.has('span-clock');
  const isAskResetOn = !off.has('compaction-ask');
  const readsCompaction = isAskResetOn || !off.has('reread-reset');
  const keepsHandback = !off.has('acceptance-claims');
  const calls = [];
  const events = [];
  const requests = new Map();
  const callById = new Map();
  let previousTimestampMs;
  let lastUserTimestampMs;
  let lastApiRequestTimestampMs;
  let firstTimestampMs;
  let lastTimestampMs;
  const lines = text.split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (!lines[lineIndex].trim()) continue;
    let record;
    try {
      record = JSON.parse(lines[lineIndex]);
    } catch {
      continue;
    }
    const lineNumber = lineIndex + 1;
    const timestampMs = Date.parse(record.timestamp ?? '');
    const message = record.message;
    const isCompaction = readsCompaction && isCompactionRecord(record);
    if (isCompaction) events.push({ type: 'compaction', line: lineNumber });
    // With compaction-ask off, a compaction record also parses as the message it was before.
    const isMessage = !isCompaction || !isAskResetOn;
    if (isMessage && record.type === 'assistant' && message) {
      const key = message.id ?? `line:${lineNumber}`;
      let request = requests.get(key);
      if (!request) {
        request = {
          startTimestampMs:
            (isClockOn ? lastApiRequestTimestampMs : undefined) ??
            lastUserTimestampMs ??
            previousTimestampMs ??
            timestampMs,
          endTimestampMs: undefined,
          lastAssistantTimestampMs: timestampMs,
          usage: undefined,
          model: undefined,
          callIndexes: [],
          firstLine: lineNumber,
        };
        requests.set(key, request);
      }
      if (!request.usage && message.usage) {
        request.usage = message.usage;
        request.model = message.model;
      }
      if (Number.isFinite(timestampMs))
        request.lastAssistantTimestampMs = timestampMs;
      for (const block of Array.isArray(message.content)
        ? message.content
        : []) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string')
          continue;
        const call = {
          index: calls.length,
          line: lineNumber,
          id: block.id,
          name: block.name ?? '',
          input: block.input ?? {},
          request,
        };
        request.callIndexes.push(call.index);
        calls.push(call);
        callById.set(call.id, call);
        events.push({ type: 'call', call });
      }
    } else if (isMessage && record.type === 'user' && message) {
      const content = message.content;
      const texts = [];
      if (typeof content === 'string') texts.push(content);
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'tool_result') {
          const call = callById.get(block.tool_use_id);
          if (!call) continue;
          if (Number.isFinite(timestampMs))
            call.request.endTimestampMs = Math.max(
              call.request.endTimestampMs ?? timestampMs,
              timestampMs,
            );
          events.push({
            type: 'result',
            call,
            text: resultText(block.content),
            line: lineNumber,
          });
        } else if (block?.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text);
        }
      }
      const text = texts.join('\n');
      if (texts.length > 0 && record.isMeta !== true)
        events.push({ type: 'user', text, line: lineNumber });
      else if (
        keepsHandback &&
        texts.length > 0 &&
        text.includes(HANDBACK_MARKER)
      )
        events.push({ type: 'handback', text, line: lineNumber });
    }
    if (Number.isFinite(timestampMs)) {
      if (record.type === 'user') {
        lastUserTimestampMs = timestampMs;
        lastApiRequestTimestampMs = undefined;
      } else if (record.type === 'api-request') {
        lastApiRequestTimestampMs = timestampMs;
      }
      previousTimestampMs = timestampMs;
      firstTimestampMs ??= timestampMs;
      lastTimestampMs = timestampMs;
    }
  }
  return { calls, events, requests, firstTimestampMs, lastTimestampMs };
}

/** Fills every call's cost, tokens, and wall seconds from its request. */
function attribute(parsed, unpriced) {
  for (const request of parsed.requests.values()) {
    const priced = requestCost(request.usage, request.model, unpriced);
    const end = request.endTimestampMs ?? request.lastAssistantTimestampMs;
    const span = Number.isFinite(end - request.startTimestampMs)
      ? Math.max(0, end - request.startTimestampMs) / MILLISECONDS_PER_SECOND
      : 0;
    request.priced = priced;
    const shares = request.callIndexes.length;
    for (const index of request.callIndexes) {
      const call = parsed.calls[index];
      call.cost = priced.cost / shares;
      call.inputTokens = priced.inputTokens / shares;
      call.outputTokens = priced.outputTokens / shares;
      call.wallSeconds = span / shares;
    }
  }
}

const isWrite = (call) => WRITE_TOOLS.has(call.name);
const writePath = (call) =>
  call.input.file_path ?? call.input.notebook_path ?? call.input.path;
const bashCommand = (call) =>
  call.name === 'Bash' && typeof call.input.command === 'string'
    ? normalize(call.input.command)
    : undefined;

const isClassifierBlock = (event) =>
  event.call.name === 'Bash' &&
  event.text.trimStart().startsWith(CLASSIFIER_NO_VERDICT);

// isKeepaliveCommand never reads run_in_background, so this checks it.
const isKeepaliveLaunch = (call) =>
  call.input.run_in_background === true &&
  isKeepaliveCommand(call.input.command);

function findRerunUnchanged({ parsed: { events }, off }) {
  const isBlockSkipOn = !off.has('rerun-classifier-blocked');
  const isKeepaliveSkipOn = !off.has('rerun-keepalive');
  const episodes = [];
  const blocked = new Set();
  const firstRunOf = new Map();
  for (const event of events) {
    if (event.type === 'result') {
      if (!isBlockSkipOn || !isClassifierBlock(event)) continue;
      blocked.add(event.call.index);
      const command = bashCommand(event.call);
      if (firstRunOf.get(command) === event.call) firstRunOf.delete(command);
      continue;
    }
    if (event.type !== 'call') continue;
    const { call } = event;
    if (isWrite(call)) {
      firstRunOf.clear();
      continue;
    }
    const command = bashCommand(call);
    if (command === undefined || !CHECK_COMMAND.test(command)) continue;
    if (isKeepaliveSkipOn && isKeepaliveLaunch(call)) continue;
    if (firstRunOf.has(command))
      episodes.push({ calls: [call], line: call.line });
    else firstRunOf.set(command, call);
  }
  return episodes.filter((episode) => !blocked.has(episode.calls[0].index));
}

function findRereadUnchanged({ parsed: { events }, off }) {
  const isResetOn = !off.has('reread-reset');
  const episodes = [];
  const reads = new Map();
  for (const event of events) {
    if (event.type === 'compaction') {
      if (isResetOn) reads.clear();
      continue;
    }
    if (event.type !== 'call') continue;
    const { call } = event;
    if (isWrite(call)) {
      const path = writePath(call);
      for (const key of reads.keys())
        if (key.startsWith(`${path}${READ_KEY_SEPARATOR}`)) reads.delete(key);
      continue;
    }
    if (call.name !== 'Read') continue;
    if (isResetOn && TASK_OUTPUT_PATH.test(call.input.file_path ?? ''))
      continue;
    const key = `${call.input.file_path}${READ_KEY_SEPARATOR}${call.input.offset ?? ''}${READ_KEY_SEPARATOR}${call.input.limit ?? ''}`;
    if (reads.has(key)) episodes.push({ calls: [call], line: call.line });
    reads.set(key, true);
  }
  return episodes;
}

const isMutating = (call) =>
  isWrite(call) ||
  (call.name === 'Bash' && MUTATING_BASH.test(call.input.command ?? ''));

function findAskToActGap({ parsed: { events }, fileName, off }) {
  if (SUBAGENT_PATH.test(fileName)) return [];
  const isAskResetOn = !off.has('compaction-ask');
  const episodes = [];
  let pending;
  for (const event of events) {
    if (event.type === 'compaction') {
      if (isAskResetOn) pending = undefined;
      continue;
    }
    if (event.type === 'user') {
      pending =
        NOT_A_REQUEST_PREFIX.test(event.text) || !ASK_PATTERN.test(event.text)
          ? undefined
          : [];
      continue;
    }
    if (event.type !== 'call' || !pending) continue;
    if (isMutating(event.call)) {
      if (pending.length >= ASK_TO_ACT_MIN_CALLS)
        episodes.push({
          calls: pending,
          line: pending[0].line,
          minCalls: ASK_TO_ACT_MIN_CALLS,
        });
      pending = undefined;
    } else {
      pending.push(event.call);
    }
  }
  return episodes;
}

const withoutPipeFilters = (command) => normalize(command.split(PIPE)[0]);

const isReport = (event, isClaimsOn) =>
  (event.type === 'result' && REPORT_TOOLS.has(event.call.name)) ||
  event.type === 'handback' ||
  (event.type === 'user' &&
    (event.text.includes('<task-notification>') ||
      (isClaimsOn && event.text.includes(HANDBACK_MARKER))));

const isUnnamedFailure = (text) =>
  FAILED_RESULT.test(text) && !NAMED_FAILURE.test(text);

/**
 * Claims a run of a command the last worker report quotes, and a rerun after a failing run that
 * named no test. Both compare the command's text before its first pipe.
 */
function findAcceptanceRerun({ parsed: { events }, off }) {
  const isClaimsOn = !off.has('acceptance-claims');
  const episodes = [];
  let report;
  const unnamedFailureSinceWrite = new Map();
  for (const event of events) {
    if (isReport(event, isClaimsOn)) {
      report = normalize(event.text);
      continue;
    }
    if (event.type === 'result') {
      const command = bashCommand(event.call);
      if (command !== undefined)
        unnamedFailureSinceWrite.set(
          withoutPipeFilters(command),
          isUnnamedFailure(event.text),
        );
      continue;
    }
    if (event.type !== 'call') continue;
    const { call } = event;
    if (SPAWN_TOOLS.has(call.name)) {
      report = undefined;
      continue;
    }
    if (isWrite(call)) {
      unnamedFailureSinceWrite.clear();
      continue;
    }
    const command = bashCommand(call);
    if (command === undefined) continue;
    const stripped = isClaimsOn ? withoutPipeFilters(command) : command;
    const isReportRerun =
      report !== undefined &&
      stripped.length >= MIN_VERBATIM_COMMAND_LENGTH &&
      report.includes(stripped);
    const isBlindRerun =
      isClaimsOn &&
      CHECK_COMMAND.test(stripped) &&
      unnamedFailureSinceWrite.get(stripped) === true;
    if (isReportRerun || isBlindRerun)
      episodes.push({ calls: [call], line: call.line });
  }
  return episodes;
}

function findGrepAfterWireitSkip({ parsed: { events } }) {
  const episodes = [];
  let sinceSkip = Infinity;
  for (const event of events) {
    if (event.type === 'result') {
      if (event.call.name === 'Bash' && WIREIT_SKIP.test(event.text))
        sinceSkip = 0;
    } else if (event.type === 'call') {
      if (sinceSkip === Infinity) continue;
      sinceSkip += 1;
      if (sinceSkip > WIREIT_FOLLOW_WINDOW) {
        sinceSkip = Infinity;
        continue;
      }
      const command = bashCommand(event.call);
      if (
        command !== undefined &&
        LOG_READ_COMMAND.test(command) &&
        LOG_TARGET.test(command)
      ) {
        episodes.push({ calls: [event.call], line: event.call.line });
        sinceSkip = Infinity;
      }
    }
  }
  return episodes;
}

function findSmallAgent({ parsed, fileName, agentType, off }) {
  if (!SUBAGENT_PATH.test(fileName)) return [];
  const lastCall = parsed.calls.at(-1);
  const workCalls =
    !off.has('terminal-handback') &&
    lastCall &&
    TERMINAL_TOOLS.has(lastCall.name)
      ? parsed.calls.slice(0, -1)
      : parsed.calls;
  if (workCalls.length >= SMALL_AGENT_MAX_CALLS) return [];
  let cost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const firstLine = parsed.requests.values().next().value?.firstLine ?? 1;
  for (const request of parsed.requests.values()) {
    cost += request.priced.cost;
    inputTokens += request.priced.inputTokens;
    outputTokens += request.priced.outputTokens;
  }
  const wallSeconds =
    parsed.firstTimestampMs !== undefined &&
    parsed.lastTimestampMs !== undefined
      ? (parsed.lastTimestampMs - parsed.firstTimestampMs) /
        MILLISECONDS_PER_SECOND
      : 0;
  return [
    {
      calls: workCalls,
      line: parsed.calls[0]?.line ?? firstLine,
      agentType,
      override: { cost, inputTokens, outputTokens, wallSeconds },
    },
  ];
}

function findPlanReadBeforeWrite({ parsed: { events } }) {
  let hasPlanProjectFired = false;
  let between = [];
  for (const event of events) {
    if (!hasPlanProjectFired) {
      hasPlanProjectFired =
        (event.type === 'call' &&
          event.call.name === 'Skill' &&
          /(?:^|:)plan-project$/.test(event.call.input.skill ?? '')) ||
        (event.type === 'user' && PLAN_COMMAND.test(event.text));
      continue;
    }
    if (event.type !== 'call') continue;
    const { call } = event;
    const path = writePath(call);
    if (
      (call.name === 'Write' || call.name === 'Edit') &&
      typeof path === 'string' &&
      path.includes(PLANS_PATH)
    ) {
      return between.length >= PLAN_READ_MIN_CALLS
        ? [{ calls: between, line: between[0].line }]
        : [];
    }
    if (!isWrite(call)) between.push(call);
  }
  return [];
}

const CLAIM_ORDER = [
  'acceptance-rerun-after-report',
  'grep-after-wireit-skip',
  'rerun-unchanged',
  'reread-unchanged',
  'plan-read-before-write',
  'ask-to-act-gap',
];

const FINDERS = {
  'rerun-unchanged': findRerunUnchanged,
  'reread-unchanged': findRereadUnchanged,
  'ask-to-act-gap': findAskToActGap,
  'acceptance-rerun-after-report': findAcceptanceRerun,
  'grep-after-wireit-skip': findGrepAfterWireitSkip,
  'small-agent': findSmallAgent,
  'plan-read-before-write': findPlanReadBeforeWrite,
};

/**
 * Classifies one transcript.
 *
 * @param text The transcript's JSONL text.
 * @param fileName The path as it should appear in pointers. A path with a `subagents`
 * segment marks a subagent transcript.
 * @param agentType The subagent's type, as `readAgentType` returns it. Each `small-agent`
 * episode carries it as `agentType`.
 * @param disabledRules The `RULE_IDS` to turn off, or `all` for every one. Empty runs every rule.
 * @returns Per-file totals and, per kind, the episodes with their attributed cost.
 */
export function classify(
  text,
  fileName,
  agentType = null,
  disabledRules = NO_RULES_OFF,
) {
  const off = disabledRules.has(ALL_RULES) ? new Set(RULE_IDS) : disabledRules;
  const unpriced = new Set();
  const parsed = parseTranscript(text, off);
  attribute(parsed, unpriced);
  const totals = { calls: parsed.calls.length, wallSeconds: 0, costUsd: 0 };
  for (const call of parsed.calls) {
    totals.wallSeconds += call.wallSeconds;
    totals.costUsd += call.cost;
  }
  const claimed = new Set();
  const found = {};
  for (const kind of [
    ...CLAIM_ORDER,
    ...KIND_NAMES.filter((name) => !CLAIM_ORDER.includes(name)),
  ]) {
    const kept = [];
    const claims = CLAIM_ORDER.includes(kind);
    for (const episode of FINDERS[kind]({ parsed, fileName, agentType, off })) {
      if (!claims) {
        kept.push(episode);
        continue;
      }
      const remaining = episode.calls.filter(
        (call) => !claimed.has(call.index),
      );
      if (remaining.length === 0 || remaining.length < (episode.minCalls ?? 1))
        continue;
      kept.push({
        ...episode,
        calls: remaining,
        line:
          remaining.length === episode.calls.length
            ? episode.line
            : remaining[0].line,
      });
    }
    for (const episode of kept)
      if (claims) for (const call of episode.calls) claimed.add(call.index);
    found[kind] = kept;
  }
  const kinds = {};
  for (const kind of KIND_NAMES) {
    kinds[kind] = found[kind].map((episode) => {
      const sum = (field) =>
        episode.override?.[field] ??
        episode.calls.reduce((total, call) => total + call[field], 0);
      return {
        pointer: `${fileName}:${episode.line}`,
        calls: episode.calls.length,
        wallSeconds: sum('wallSeconds'),
        inputTokens: sum('inputTokens'),
        outputTokens: sum('outputTokens'),
        costUsd: sum('cost'),
        ...(kind === 'small-agent' ? { agentType: episode.agentType } : {}),
      };
    });
  }
  return { fileName, totals, kinds, unpriced: [...unpriced] };
}

const round = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/** Sums `small-agent` episodes per agent type, `null` as its own type, ranked by cost. */
function agentTypeShares(episodes) {
  const groups = new Map();
  for (const episode of episodes) {
    const agentType = episode.agentType ?? null;
    const group = groups.get(agentType) ?? {
      agentType,
      count: 0,
      calls: 0,
      wallSeconds: 0,
      costUsd: 0,
    };
    group.count += 1;
    group.calls += episode.calls;
    group.wallSeconds += episode.wallSeconds;
    group.costUsd += episode.costUsd;
    groups.set(agentType, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      wallSeconds: round(group.wallSeconds, WALL_DECIMALS),
      costUsd: round(group.costUsd, COST_DECIMALS),
    }))
    .toSorted((left, right) => right.costUsd - left.costUsd);
}

/**
 * Folds per-file classifications into the `waste-audit@3` document. The `small-agent` kind
 * entry, and no other, carries `agentTypes`, one `{ agentType, count, calls, wallSeconds,
 * costUsd }` per distinct agent type with `null` as its own element, sorted by cost descending.
 */
export function summarize(fileResults) {
  const totals = { calls: 0, wallSeconds: 0, costUsd: 0 };
  const unpriced = new Set();
  const accumulators = new Map(
    KIND_NAMES.map((kind) => [
      kind,
      {
        count: 0,
        calls: 0,
        wallSeconds: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        files: new Set(),
        episodes: [],
      },
    ]),
  );
  for (const result of fileResults) {
    totals.calls += result.totals.calls;
    totals.wallSeconds += result.totals.wallSeconds;
    totals.costUsd += result.totals.costUsd;
    for (const model of result.unpriced) unpriced.add(model);
    for (const kind of KIND_NAMES) {
      const accumulator = accumulators.get(kind);
      for (const episode of result.kinds[kind]) {
        accumulator.count += 1;
        accumulator.calls += episode.calls;
        accumulator.wallSeconds += episode.wallSeconds;
        accumulator.inputTokens += episode.inputTokens;
        accumulator.outputTokens += episode.outputTokens;
        accumulator.costUsd += episode.costUsd;
        accumulator.files.add(result.fileName);
        accumulator.episodes.push(episode);
      }
    }
  }
  return {
    schema: SCHEMA_VERSION,
    sessions: fileResults.length,
    totals: {
      calls: totals.calls,
      wallSeconds: round(totals.wallSeconds, WALL_DECIMALS),
      costUsd: round(totals.costUsd, COST_DECIMALS),
    },
    unpricedModels: [...unpriced].sort(),
    kinds: KIND_NAMES.map((kind) => {
      const accumulator = accumulators.get(kind);
      return {
        kind,
        rule: KIND_RULES[kind],
        count: accumulator.count,
        calls: accumulator.calls,
        wallSeconds: round(accumulator.wallSeconds, WALL_DECIMALS),
        inputTokens: Math.round(accumulator.inputTokens),
        outputTokens: Math.round(accumulator.outputTokens),
        costUsd: round(accumulator.costUsd, COST_DECIMALS),
        sessionsAffected: accumulator.files.size,
        pointers: accumulator.episodes
          .toSorted((left, right) => right.costUsd - left.costUsd)
          .map((episode) => episode.pointer),
        ...(kind === 'small-agent'
          ? { agentTypes: agentTypeShares(accumulator.episodes) }
          : {}),
      };
    }),
  };
}

/**
 * Reads a subagent's type from the `.meta.json` Claude Code writes beside its transcript, so
 * `agent-<id>.jsonl` reads `agent-<id>.meta.json`. Never throws.
 *
 * @param transcriptPath A subagent transcript's path, ending in `.jsonl`.
 * @returns The `agentType` string, or `null` when the file is missing, does not parse, or has
 * no string `agentType` field.
 */
export function readAgentType(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl'))
    return null;
  try {
    const meta = JSON.parse(
      readFileSync(transcriptPath.replace(/\.jsonl$/, '.meta.json'), 'utf8'),
    );
    return typeof meta?.agentType === 'string' ? meta.agentType : null;
  } catch {
    return null;
  }
}

/** Reads the path column of a baseline sessions list. */
function parseSessionsList(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => line.split('\t')[0]);
}

/** Keeps a summarized kind's figures and pointers, without its `rule` or `agentTypes`. */
const ablatedFigures = (entry) => ({
  kind: entry.kind,
  count: entry.count,
  calls: entry.calls,
  wallSeconds: entry.wallSeconds,
  inputTokens: entry.inputTokens,
  outputTokens: entry.outputTokens,
  costUsd: entry.costUsd,
  sessionsAffected: entry.sessionsAffected,
  pointers: entry.pointers,
});

const USAGE =
  'Usage: node waste-audit.mjs [--ablate] [--sessions <sessions.txt>] [<transcript.jsonl> ...]';

function main(argv) {
  const paths = [];
  let isAblating = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--ablate') {
      isAblating = true;
    } else if (argv[i] === '--sessions') {
      const listFile = argv[i + 1];
      if (!listFile) {
        console.error(USAGE);
        return 2;
      }
      paths.push(...parseSessionsList(readFileSync(listFile, 'utf8')));
      i += 1;
    } else {
      paths.push(argv[i]);
    }
  }
  const transcripts = paths.filter(
    (path) => basename(path) !== 'journal.jsonl',
  );
  if (transcripts.length === 0) {
    console.error(USAGE);
    return 2;
  }
  const results = [];
  const ablated = new Map(
    (isAblating ? ABLATION_IDS : []).map((rule) => [rule, []]),
  );
  for (const path of transcripts) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      console.error(`skipped ${path}: ${error.message}`);
      continue;
    }
    const agentType = SUBAGENT_PATH.test(path) ? readAgentType(path) : null;
    results.push(classify(text, path, agentType));
    for (const [rule, ruleResults] of ablated)
      ruleResults.push(classify(text, path, agentType, new Set([rule])));
  }
  const output = summarize(results);
  if (isAblating)
    output.ablation = [...ablated].map(([rule, ruleResults]) => ({
      rule,
      kinds: summarize(ruleResults).kinds.map(ablatedFigures),
    }));
  console.log(JSON.stringify(output, null, 2));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
