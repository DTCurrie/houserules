import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  CLAIM_IDS,
  DECOY_PLAN,
  FIXTURE_PLAN,
  RUN_JSON,
  STREAM,
  TRANSCRIPTS,
} from './layout.mjs';

/**
 * Everything the predicates read from one session directory under `--out`.
 *
 * @typedef {object} SampleArtifacts
 * @property {string} label The session directory's basename, which starts each verdict line.
 * @property {import('./layout.mjs').RunRecord | null} run
 * @property {object[]} stream The parsed `stream.jsonl` lines.
 * @property {Array<{ agentId: string, agentType: string | null, records: object[] }>} subagents
 *   One entry per `transcripts/<session_id>/subagents/agent-*.jsonl`, with `agentType` from its
 *   `.meta.json`.
 */

/**
 * @typedef {{ result: 'pass' | 'fail' | null, line: string }} PredicateResult `line` is the
 *   one line that decided it.
 */

const PHASE_SECTIONS = Object.freeze([
  'Status table',
  'Landed',
  'Verify',
  'Ruling needed',
  'Rulings made',
  'Backlogged',
  'Out of scope',
  'Requests',
  'Decide candidates',
  'Resume',
]);
const RULING_NEEDED = 'Ruling needed';
const WORKER_SECTIONS = Object.freeze([
  'Files',
  'Acceptance',
  'Deviations',
  'Requests',
  'Out of scope',
]);
const PHASE_LINE_PREFIX = 'PHASE ';
const PHASE_FIRST_LINE = new RegExp(
  `^${PHASE_LINE_PREFIX}${FIXTURE_PLAN}/1: (WAVE_CLOSED \\d+/\\d+|DONE|NEEDS_RULING|BLOCKED|PARTIAL)\\s*$`,
);
const SLICE_FIRST_LINE =
  /^SLICE (\S+?): (DONE_WITH_CONCERNS|DONE|NEEDS_CONTEXT|BLOCKED)\s*$/;
const PHASE_ONE = /\bphase\s*1\b/i;
const MARKDOWN_EMPHASIS = /[*_`]/g;
const CD_PREFIX = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/;
const PHASE_ORCHESTRATOR = 'phase-orchestrator';
const TASK_WORKER = 'task-worker';
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INCONCLUSIVE = 2;
/** Named-plan samples a claim needs, all passing, to read PASS. */
const MIN_VALID_SAMPLES = 3;

/** @param {string} path */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The parsed lines of a JSONL file, skipping blank and unparseable lines, or `[]` when absent.
 *
 * @param {string} path
 * @returns {object[]}
 */
function readJsonl(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn last line from a killed session carries nothing a predicate reads.
    }
  }
  return records;
}

/**
 * Every `agent-<id>.jsonl` under `transcripts/<session_id>/subagents/`, for each session
 * directory copied there.
 *
 * @param {string} dir
 */
function loadSubagents(dir) {
  const root = join(dir, TRANSCRIPTS);
  if (!existsSync(root)) return [];
  const subagents = [];
  for (const session of readdirSync(root, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const subdir = join(root, session.name, 'subagents');
    if (!existsSync(subdir)) continue;
    for (const name of readdirSync(subdir).sort()) {
      const match = /^agent-(.+)\.jsonl$/.exec(name);
      if (!match) continue;
      const meta = readJson(join(subdir, `agent-${match[1]}.meta.json`));
      subagents.push({
        agentId: match[1],
        agentType: typeof meta?.agentType === 'string' ? meta.agentType : null,
        records: readJsonl(join(subdir, name)),
      });
    }
  }
  return subagents;
}

/**
 * @param {string} dir One session directory under `--out`.
 * @returns {SampleArtifacts}
 */
export function loadSample(dir) {
  return {
    label: basename(dir),
    run: readJson(join(dir, RUN_JSON)),
    stream: readJsonl(join(dir, STREAM)),
    subagents: loadSubagents(dir),
  };
}

/** The last `result` event of the dispatcher's stream, or null. */
function resultEvent(sample) {
  const results = sample.stream.filter((event) => event?.type === 'result');
  return results.at(-1) ?? null;
}

/** How many of `type` the result event's `subagent_stats.by_type` counts. */
function countByType(event, type) {
  const entry = event?.subagent_stats?.by_type?.[type];
  if (typeof entry === 'number') return entry;
  if (entry && typeof entry === 'object') {
    return Number(entry.count ?? entry.spawned ?? 1) || 0;
  }
  return 0;
}

/**
 * @param {SampleArtifacts} sample
 * @param {string} [requiredAgent] The subagent type `subagent_stats.by_type` must count at
 *   least once. A fixture names its own, and the orchestrate-report check needs
 *   `phase-orchestrator`.
 * @returns {{ valid: boolean, line: string }}
 */
export function judgeValidity(sample, requiredAgent = PHASE_ORCHESTRATOR) {
  const voided = (cause) => ({
    valid: false,
    line: `${sample.label}: void, ${cause}`,
  });
  if (!sample.run) return voided(`no ${RUN_JSON}`);
  if (sample.stream.length === 0) return voided(`no ${STREAM}`);
  const result = resultEvent(sample);
  if (!result) return voided('no result event');
  if (result.subtype !== 'success')
    return voided(`result subtype ${result.subtype}`);
  if (result.is_error !== false)
    return voided(`result is_error ${result.is_error}`);
  if (countByType(result, requiredAgent) < 1)
    return voided(`no ${requiredAgent} spawned`);
  return { valid: true, line: `${sample.label}: valid` };
}

/** A message's content blocks, with a bare string read as one text block. */
function contentBlocks(record) {
  const content = record?.message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

/** The text a `tool_result` block carries, whether its content is a string or blocks. */
function toolResultText(block) {
  if (typeof block.content === 'string') return block.content;
  if (!Array.isArray(block.content)) return '';
  return block.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/**
 * An agent's final reply: the `input.message` of its last `SubagentHandback` call, else the text
 * of its last assistant message that holds text.
 *
 * @param {object[]} records
 * @returns {string | null}
 */
function finalReply(records) {
  let handback = null;
  let lastText = null;
  for (const record of records) {
    if (record?.type !== 'assistant') continue;
    const blocks = contentBlocks(record);
    for (const block of blocks) {
      if (
        block?.type === 'tool_use' &&
        block.name === 'SubagentHandback' &&
        typeof block.input?.message === 'string'
      ) {
        handback = block.input.message;
      }
    }
    const text = blocks
      .filter(
        (block) => block?.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('\n');
    if (text.trim() !== '') lastText = text;
  }
  return handback ?? lastText;
}

/** Whether a stream event is the dispatcher's own, not one relayed from inside a subagent. */
function isDispatcherEvent(event) {
  return event?.parent_tool_use_id == null;
}

/**
 * The phase-orchestrator's report: its final reply, else the last text in the stream, from an
 * assistant text block or a `tool_result`, whose first non-blank line starts `PHASE `.
 *
 * @param {SampleArtifacts} sample
 * @returns {string | null}
 */
function phaseReport(sample) {
  for (const agent of sample.subagents) {
    if (agent.agentType !== PHASE_ORCHESTRATOR) continue;
    const reply = finalReply(agent.records);
    if (reply && firstLine(reply).startsWith(PHASE_LINE_PREFIX)) return reply;
  }
  let found = null;
  for (const event of sample.stream) {
    for (const block of contentBlocks(event)) {
      let text = null;
      if (block?.type === 'text') text = block.text;
      else if (block?.type === 'tool_result') text = toolResultText(block);
      if (
        typeof text === 'string' &&
        firstLine(text).startsWith(PHASE_LINE_PREFIX)
      )
        found = text;
    }
  }
  return found;
}

/** The commands of an agent's `Bash` tool calls. */
function bashCommands(records) {
  const commands = [];
  for (const record of records) {
    if (record?.type !== 'assistant') continue;
    for (const block of contentBlocks(record)) {
      if (
        block?.type === 'tool_use' &&
        block.name === 'Bash' &&
        typeof block.input?.command === 'string'
      ) {
        commands.push(block.input.command);
      }
    }
  }
  return commands;
}

/** Each task-worker whose transcript holds a reply, with its reply and Bash commands. */
function workerReplies(sample) {
  return sample.subagents
    .filter((agent) => agent.agentType === TASK_WORKER)
    .map((agent) => ({
      agentId: agent.agentId,
      reply: finalReply(agent.records),
      commands: bashCommands(agent.records),
    }))
    .filter(
      (worker) =>
        typeof worker.reply === 'string' && worker.reply.trim() !== '',
    );
}

/** The dispatcher's text blocks before its first `Agent` call, in order. */
function textBeforeFirstAgent(sample) {
  const texts = [];
  for (const event of sample.stream) {
    if (event?.type !== 'assistant' || !isDispatcherEvent(event)) continue;
    for (const block of contentBlocks(event)) {
      if (block?.type === 'tool_use' && block.name === 'Agent') return texts;
      if (block?.type === 'text' && typeof block.text === 'string')
        texts.push(block.text);
    }
  }
  return texts;
}

/** @param {string} text */
function splitLines(text) {
  return text.split(/\r?\n/);
}

/** @param {string} text */
function firstLine(text) {
  return splitLines(text).find((line) => line.trim() !== '') ?? '';
}

/**
 * A heading line's section name: leading `#` marks, `*` emphasis, and one trailing colon
 * stripped.
 *
 * @param {string} line
 * @returns {string}
 */
function normalizeHeading(line) {
  let name = line
    .trim()
    .replace(/^#+\s*/, '')
    .replaceAll('*', '')
    .trim();
  if (name.endsWith(':')) name = name.slice(0, -1).trimEnd();
  return name;
}

/** Markdown emphasis and code marks removed: every `*`, `_`, and backtick. */
function stripEmphasis(text) {
  return text.replace(MARKDOWN_EMPHASIS, '');
}

/** The first line that is a diff line, starting `diff --git ` or `@@ -`, or null. */
function diffLine(text) {
  return (
    splitLines(text).find(
      (line) => line.startsWith('diff --git ') || line.startsWith('@@ -'),
    ) ?? null
  );
}

/**
 * Checks that each required section name occurs as a heading line, in order.
 *
 * @param {string} text
 * @param {readonly string[]} expected In order. A name in `optional` may be absent.
 * @param {readonly string[]} [optional]
 * @returns {string | null} What is wrong, or null.
 */
function sectionOrderProblem(text, expected, optional = []) {
  const headings = splitLines(text).map(normalizeHeading);
  let previous = -1;
  let previousName = null;
  for (const name of expected) {
    const index = headings.indexOf(name);
    if (index === -1) {
      if (optional.includes(name)) continue;
      return `no ${name} heading`;
    }
    if (index < previous) return `${name} heading before ${previousName}`;
    previous = index;
    previousName = name;
  }
  return null;
}

/**
 * The lines of one section: those after its heading, up to the next heading in `sections`.
 *
 * @returns {string[] | null} Null when the section is absent.
 */
function sectionLines(text, name, sections) {
  const lines = splitLines(text);
  const start = lines.findIndex((line) => normalizeHeading(line) === name);
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (sections.includes(normalizeHeading(line))) break;
    body.push(line);
  }
  return body;
}

/** Whether a reported command equals a transcript command, as run or after a `cd <path> &&`. */
function commandMatches(reported, ran) {
  const command = ran.trim();
  return (
    command === reported || command.replace(CD_PREFIX, '').trim() === reported
  );
}

const pass = (line) => ({ result: 'pass', line });
const fail = (line) => ({ result: 'fail', line });
const none = (line) => ({ result: null, line });

/** @param {SampleArtifacts} sample */
function orch042(sample) {
  const report = phaseReport(sample);
  if (!report) return none('no phase-orchestrator report found');
  const first = firstLine(report).trim();
  const match = PHASE_FIRST_LINE.exec(first);
  if (!match)
    return fail(
      `first line is not PHASE ${FIXTURE_PLAN}/1 with a status: ${first}`,
    );
  const optional = match[1] === 'NEEDS_RULING' ? [] : [RULING_NEEDED];
  const problem = sectionOrderProblem(report, PHASE_SECTIONS, optional);
  if (problem) return fail(`report ${problem}`);
  return pass(`${first}, ten sections in order`);
}

/** @param {SampleArtifacts} sample */
function orch001(sample) {
  const workers =
    sample.subagents.filter((agent) => agent.agentType === TASK_WORKER)
      .length || countByType(resultEvent(sample), TASK_WORKER);
  if (workers < 1) return fail('no task-worker spawned');
  const tree = sample.run?.leftTree;
  if (!tree) return none(`${RUN_JSON} holds no left tree`);
  if (!/\bDONE\b/.test(tree.roadmapPhase1 ?? '')) {
    return fail(`ROADMAP phase 1 reads ${JSON.stringify(tree.roadmapPhase1)}`);
  }
  const acceptances = Object.entries(tree.acceptances ?? {});
  if (acceptances.length === 0)
    return none(`${RUN_JSON} holds no acceptance rerun`);
  const red = acceptances.filter(([, code]) => code !== 0);
  if (red.length > 0) {
    return fail(
      `acceptance ${red.map(([step, code]) => `${step} exited ${code}`).join(', ')}`,
    );
  }
  const report = phaseReport(sample);
  if (!report) return none('no phase-orchestrator report found');
  const diff = diffLine(report);
  if (diff) return fail(`report holds a diff line: ${diff}`);
  return pass(
    `${workers} task-worker(s), phase 1 DONE, ${acceptances.length} acceptances exit 0, no diff`,
  );
}

/** @param {SampleArtifacts} sample */
function orch071(sample) {
  const tree = sample.run?.leftTree;
  if (!tree) return none(`${RUN_JSON} holds no left tree`);
  const changed = Object.entries(tree.decoyIntact ?? {})
    .filter(([, intact]) => !intact)
    .map(([file]) => file);
  if (changed.length > 0)
    return fail(`decoy plan file changed: ${changed.join(', ')}`);
  if (tree.hasDecoyJs) return fail('src/decoy.js exists');
  // Sample 1's dispatcher wrote "phase **1 (helpers)**", so emphasis marks hide the phase number.
  const texts = textBeforeFirstAgent(sample).map(stripEmphasis);
  const all = texts.join('\n');
  if (all.includes(DECOY_PLAN) && !all.includes(FIXTURE_PLAN)) {
    return fail(
      `dispatcher named ${DECOY_PLAN}, not ${FIXTURE_PLAN}, before its first Agent call`,
    );
  }
  const stated = texts.find(
    (text) => text.includes(FIXTURE_PLAN) && PHASE_ONE.test(text),
  );
  if (!stated) {
    return fail(
      `no dispatcher text before its first Agent call names ${FIXTURE_PLAN} and phase 1`,
    );
  }
  return pass(
    `stated ${FIXTURE_PLAN} phase 1 before the first Agent call, decoy intact`,
  );
}

/**
 * The `$ command` entries of an Acceptance section, each with a count of the output lines under it.
 *
 * A command is the longest run of lines that starts at its `$` line with the `$ ` dropped and
 * stops before the next line starting `$ `. Joined with newlines and trimmed, the run must match
 * one of the worker's Bash calls through `commandMatches`. When no run of two or more lines
 * matches, the command is the `$` line alone. Each non-blank line after the command, up to the
 * next `$ ` line, is output. A line starting `$ ` always opens a new entry. The transcript marks
 * where the command ends because the report format reserves no continuation line form.
 *
 * @param {string[]} body
 * @param {string[]} ranCommands
 * @returns {Array<{ command: string, outputLineCount: number }>}
 */
function acceptanceEntries(body, ranCommands) {
  const entries = [];
  let index = 0;
  while (index < body.length) {
    const line = body[index];
    if (!line.startsWith('$ ')) {
      if (line.trim() !== '' && entries.length > 0)
        entries.at(-1).outputLineCount += 1;
      index += 1;
      continue;
    }
    const length = commandLineCount(body, index, ranCommands);
    entries.push({
      command: joinCommandLines(body, index, length),
      outputLineCount: 0,
    });
    index += length;
  }
  return entries;
}

/** The fewest report lines a multi-line command spans. */
const MIN_MULTI_LINE_COMMAND_LINES = 2;

/**
 * The command a `$` entry spans, as `length` lines from `start` with the `$ ` dropped.
 *
 * @param {string[]} body
 * @param {number} start
 * @param {number} length
 */
function joinCommandLines(body, start, length) {
  return [body[start].slice(2), ...body.slice(start + 1, start + length)]
    .join('\n')
    .trim();
}

/**
 * How many lines the `$` entry at `start` spans: the longest run that matches a ran command,
 * or 1 when no multi-line run does.
 *
 * @param {string[]} body
 * @param {number} start
 * @param {string[]} ranCommands
 */
function commandLineCount(body, start, ranCommands) {
  let runEnd = start + 1;
  while (runEnd < body.length && !body[runEnd].startsWith('$ ')) runEnd += 1;
  for (
    let candidate = runEnd - start;
    candidate >= MIN_MULTI_LINE_COMMAND_LINES;
    candidate -= 1
  ) {
    const joined = joinCommandLines(body, start, candidate);
    if (ranCommands.some((ran) => commandMatches(joined, ran)))
      return candidate;
  }
  return 1;
}

/** @param {SampleArtifacts} sample */
function agent059(sample) {
  const workers = workerReplies(sample);
  if (workers.length === 0) return none('no task-worker reply found');
  for (const { agentId, reply, commands } of workers) {
    const body = sectionLines(reply, 'Acceptance', WORKER_SECTIONS);
    if (!body) return fail(`worker ${agentId} reply has no Acceptance section`);
    const entries = acceptanceEntries(body, commands);
    if (entries.length === 0)
      return fail(`worker ${agentId} Acceptance holds no $ command`);
    for (const { command, outputLineCount } of entries) {
      if (outputLineCount === 0)
        return fail(`worker ${agentId} $ ${command} has no output line`);
      if (!commands.some((ran) => commandMatches(command, ran))) {
        return fail(
          `worker ${agentId} $ ${command} matches no Bash command it ran`,
        );
      }
    }
  }
  return pass(
    `${workers.length} worker reply(s), every $ command ran and shows output`,
  );
}

/** @param {SampleArtifacts} sample */
function agent062(sample) {
  const workers = workerReplies(sample);
  if (workers.length === 0) return none('no task-worker reply found');
  for (const { agentId, reply } of workers) {
    const first = firstLine(reply).trim();
    if (!SLICE_FIRST_LINE.test(first)) {
      return fail(
        `worker ${agentId} first line is not SLICE with a status: ${first}`,
      );
    }
    const problem = sectionOrderProblem(reply, WORKER_SECTIONS);
    if (problem) return fail(`worker ${agentId} reply ${problem}`);
    const diff = diffLine(reply);
    if (diff) return fail(`worker ${agentId} reply holds a diff line: ${diff}`);
  }
  return pass(
    `${workers.length} worker reply(s), SLICE line, five sections in order, no diff`,
  );
}

/** @type {Readonly<Record<string, (sample: SampleArtifacts) => PredicateResult>>} */
export const PREDICATES = Object.freeze({
  'agent-059': agent059,
  'agent-062': agent062,
  'orch-001': orch001,
  'orch-042': orch042,
  'orch-071': orch071,
});

/**
 * One claim's verdict from its per-sample results.
 *
 * @param {string} id
 * @param {Array<{ isNamedPlan: boolean, result: 'pass' | 'fail' | null }>} results
 * @returns {'PASS' | 'FAIL' | 'INCONCLUSIVE'}
 */
function claimVerdict(id, results) {
  if (results.some((outcome) => outcome.result === 'fail')) return 'FAIL';
  const namedPasses = results.filter(
    (outcome) => outcome.isNamedPlan && outcome.result === 'pass',
  ).length;
  const noSlugPasses = results.some(
    (outcome) => !outcome.isNamedPlan && outcome.result === 'pass',
  );
  if (
    namedPasses >= MIN_VALID_SAMPLES &&
    results.every((outcome) => outcome.result === 'pass') &&
    (id !== 'orch-071' || noSlugPasses)
  ) {
    return 'PASS';
  }
  return 'INCONCLUSIVE';
}

/**
 * @param {Record<string, 'PASS' | 'FAIL' | 'INCONCLUSIVE'>} claims
 * @returns {0 | 1 | 2}
 */
function exitCodeFor(claims) {
  const values = Object.values(claims);
  if (values.includes('FAIL')) return EXIT_FAIL;
  if (values.every((value) => value === 'PASS')) return EXIT_PASS;
  return EXIT_INCONCLUSIVE;
}

/**
 * The verdict over every loaded session: named-plan samples in order, and the no-slug session
 * or null.
 *
 * @param {{ samples: SampleArtifacts[], noSlug: SampleArtifacts | null }} options
 * @returns {{ claims: Record<string, 'PASS' | 'FAIL' | 'INCONCLUSIVE'>, lines: Record<string, string[]>, exitCode: 0 | 1 | 2 }}
 */
export function verdict(options) {
  const samples = options?.samples ?? [];
  const noSlug = options?.noSlug ?? null;
  const judged = [...samples, ...(noSlug ? [noSlug] : [])].map((sample) => ({
    sample,
    validity: judgeValidity(sample),
    isNamedPlan: sample !== noSlug,
  }));
  /** @type {Record<string, 'PASS' | 'FAIL' | 'INCONCLUSIVE'>} */
  const claims = {};
  /** @type {Record<string, string[]>} */
  const lines = {};
  for (const id of CLAIM_IDS) {
    const results = [];
    lines[id] = [];
    for (const { sample, validity, isNamedPlan } of judged) {
      if (!validity.valid) {
        lines[id].push(validity.line);
        continue;
      }
      const { result, line } = PREDICATES[id](sample);
      results.push({ isNamedPlan, result });
      lines[id].push(`${sample.label}: ${result ?? 'no result'}, ${line}`);
    }
    claims[id] = claimVerdict(id, results);
  }
  const exitCode = exitCodeFor(claims);
  return { claims, lines, exitCode };
}
