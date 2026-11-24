#!/usr/bin/env node
/**
 * Prints, per plan doc, the Write, Edit, and MultiEdit calls after its first write, the Bash calls
 * that write it, and the plan-lint findings that follow a plan write. Then prints a summary per
 * side of the landing date.
 *
 * Usage: node plan-doc-writes.mjs --landed <iso-date> [--sessions <sessions.txt>] [--lint-window <n>] [--json <out>] [<main.jsonl>...]
 *
 * Each positional path is a main transcript `<dir>/<session>.jsonl`. The script also reads every
 * subagent transcript under `<dir>/<session>/subagents/`. `--sessions` reads the paths from a
 * baseline `sessions.txt`, the first tab-separated field of each line that is not a `#` comment,
 * and keeps the main transcripts. `--landed` is the moment `plan-scaffold` and `plan-state`
 * landed. `--lint-window` is N, the number of tool calls after a plan write inside which a
 * plan-lint run counts as following it, 5 by default. `--json` also writes
 * `{ "schema": "plan-doc-writes@1", "landed", "lintWindow", "docs": [...], "lintRuns": [...], "sides": {...} }`.
 *
 * Definitions. A plan doc is a file `ROADMAP.md`, `PLAN.md`, `MILESTONE.md`, or `phase-*.md` under
 * `.claude/plans/<dir>/`, at any depth, `_archive` and `_health-checks` included. It is keyed by
 * its path after `.claude/plans/`, across every transcript. A tool write is a Write, Edit, or
 * MultiEdit call on a plan doc. A Bash write is a Bash call that redirects into a plan doc,
 * runs `sed -i` or `tee` on one, runs `plan-state set <workspace>` (which writes
 * `<workspace>/ROADMAP.md`), or runs `plan-scaffold <slug> --phases ...` (which writes `PLAN.md`
 * and `ROADMAP.md` of `<slug>`). A key with a glob or placeholder character or a nested
 * `.claude/` is not a doc. A doc's first write is its earliest write of either kind by
 * timestamp. That write is the scaffold, so edits after scaffold are the tool writes after it, and
 * the Bash writes after it are a separate count. A doc is on the `before` side when its first write
 * precedes `--landed`, and on the `after` side otherwise.
 *
 * A plan-lint run is a Bash call whose command runs `plan-lint.mjs` or `plan-lint.mts`. It follows
 * a plan write when that write is the latest one before it in the same transcript and at most N
 * tool calls earlier. The run takes the side of the written doc. Its findings are the lines of its
 * tool_result that hold `ERROR` or `WARN` followed by a bracketed rule. A result that the harness
 * saved to a file shows only its preview, so findings past the preview are not counted.
 *
 * Exit codes: 0 printed, 2 bad usage. Reads transcripts only, writes `--json` only. Node builtins
 * only.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const SCHEMA_VERSION = 'plan-doc-writes@1';
const DEFAULT_LINT_WINDOW = 5;
const EXIT_USAGE = 2;
const TOOL_WRITE_NAMES = new Set(['Write', 'Edit', 'MultiEdit']);
const SIDES = ['before', 'after'];
const PLAN_DOC =
  /(?:^|\/)\.claude\/plans\/((?:[^/]+\/)+(?:(?:ROADMAP|PLAN|MILESTONE)\.md|phase-[^/]*\.md))$/;
const PLAN_PATH_IN_COMMAND = /\.claude\/plans\/[^\s"'`;|&)]+\.md/g;
const REDIRECT_INTO_PLAN =
  /(?<![0-9&>])>>?\s*["']?[^\s"'&;|]*\.claude\/plans\/[^\s"'`;|&)]+\.md/g;
const SED_IN_PLACE = /\bsed\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*i/;
const TEE = /\btee\b/;
const PLAN_STATE_SET = /\bplan-state(?:\.mjs|\.mts)?\s+set\s+["']?([^\s"']+)/;
const PLAN_SCAFFOLD =
  /\bplan-scaffold(?:\.mjs|\.mts)?\s+["']?([a-z0-9-]+)["']?\s+--phases\b/;
const NOT_A_PATH = /[*<>$`{}]|\.claude\//;
const PLAN_LINT = /\bplan-lint\.m[jt]s\b/;
const FINDING_LINE = /\b(ERROR|WARN)\s+\[/;
const PLANS_SEGMENT = '.claude/plans/';
const USAGE =
  'usage: node plan-doc-writes.mjs --landed <iso-date> [--sessions <sessions.txt>] [--lint-window <n>] [--json <out>] [<main.jsonl>...]';

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
    landed: null,
    sessions: null,
    lintWindow: DEFAULT_LINT_WINDOW,
    json: null,
    mains: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (
      arg === '--landed' ||
      arg === '--sessions' ||
      arg === '--lint-window' ||
      arg === '--json'
    ) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        usageError(`${arg} needs a value`);
      i += 1;
      if (arg === '--landed') options.landed = value;
      else if (arg === '--sessions') options.sessions = value;
      else if (arg === '--json') options.json = value;
      else {
        const window = Number(value);
        if (!Number.isInteger(window) || window < 1)
          usageError(`--lint-window takes a positive integer, got ${value}`);
        options.lintWindow = window;
      }
    } else if (arg.startsWith('--')) {
      usageError(`unknown flag ${arg}`);
    } else {
      options.mains.push(arg);
    }
  }
  if (options.landed === null) usageError('--landed is required');
  if (Number.isNaN(Date.parse(options.landed)))
    usageError(`--landed takes an ISO date, got ${options.landed}`);
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

function resultText(block) {
  if (typeof block.content === 'string') return block.content;
  if (!Array.isArray(block.content)) return '';
  return block.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

function planDocKey(filePath) {
  if (typeof filePath !== 'string') return null;
  const key = filePath.match(PLAN_DOC)?.[1] ?? null;
  return key && !NOT_A_PATH.test(key) ? key : null;
}

function keyAfterPlansSegment(path) {
  const at = path.indexOf(PLANS_SEGMENT);
  if (at === -1) return null;
  return path
    .slice(at + PLANS_SEGMENT.length)
    .replace(/\/+$/, '')
    .replace(/^\/+/, '');
}

/**
 * The plan docs a Bash command writes, as keys. Empty for a command that only reads them.
 */
function bashWrittenDocs(command) {
  const written = new Set();
  const add = (path) => {
    const key = planDocKey(
      path.startsWith('/') ? path : `/${path.replace(/^\.?\//, '')}`,
    );
    if (key) written.add(key);
  };
  for (const redirect of command.matchAll(REDIRECT_INTO_PLAN)) {
    const path = redirect[0].match(PLAN_PATH_IN_COMMAND)?.[0];
    if (path) add(path);
  }
  if (SED_IN_PLACE.test(command) || TEE.test(command)) {
    for (const path of command.match(PLAN_PATH_IN_COMMAND) ?? []) add(path);
  }
  const stateSet = command.match(PLAN_STATE_SET);
  if (stateSet) {
    const workspace = keyAfterPlansSegment(stateSet[1]);
    if (workspace) add(`${PLANS_SEGMENT}${workspace}/ROADMAP.md`);
  }
  const scaffold = command.match(PLAN_SCAFFOLD);
  if (scaffold) {
    add(`${PLANS_SEGMENT}${scaffold[1]}/PLAN.md`);
    add(`${PLANS_SEGMENT}${scaffold[1]}/ROADMAP.md`);
  }
  return [...written];
}

/**
 * Reads one transcript and returns its tool calls in file order, each as
 * `{ timestampMilliseconds, index, name, writes: [{ doc, kind }], isLint, findings }`. A plan-lint call carries the
 * counts of `ERROR` and `WARN` lines in its result.
 */
function callsOf(records, label) {
  const calls = [];
  const byId = new Map();
  for (const record of records) {
    const timestampMilliseconds = Date.parse(record.timestamp);
    if (Number.isNaN(timestampMilliseconds)) continue;
    for (const block of contentBlocks(record)) {
      if (record.type === 'assistant' && block.type === 'tool_use') {
        const call = callFromToolUse(
          block,
          timestampMilliseconds,
          label,
          calls.length,
        );
        calls.push(call);
        byId.set(block.id, call);
        continue;
      }
      if (record.type !== 'user' || block.type !== 'tool_result') continue;
      const call = byId.get(block.tool_use_id);
      if (!call?.isLint) continue;
      countLintFindings(call, resultText(block));
    }
  }
  return calls;
}

function callFromToolUse(block, timestampMilliseconds, label, index) {
  const call = {
    timestampMilliseconds,
    transcript: label,
    index,
    name: block.name,
    writes: [],
    isLint: false,
    errors: 0,
    warns: 0,
  };
  if (TOOL_WRITE_NAMES.has(block.name)) {
    const doc = planDocKey(block.input?.file_path);
    if (doc) call.writes.push({ doc, kind: 'tool' });
  } else if (block.name === 'Bash') {
    const command = String(block.input?.command ?? '');
    for (const doc of bashWrittenDocs(command))
      call.writes.push({ doc, kind: 'bash' });
    call.isLint = PLAN_LINT.test(command);
  }
  return call;
}

function countLintFindings(call, text) {
  for (const line of text.split('\n')) {
    const match = line.match(FINDING_LINE);
    if (!match) continue;
    if (match[1] === 'ERROR') call.errors += 1;
    else call.warns += 1;
  }
}

function collectTranscripts(mains) {
  const transcripts = [];
  for (const mainPath of mains) {
    if (!existsSync(mainPath)) {
      console.error(`missing transcript: ${mainPath}`);
      continue;
    }
    const session = basename(mainPath, '.jsonl');
    transcripts.push({
      session,
      isMain: true,
      calls: callsOf(readRecords(mainPath), 'main'),
    });
    for (const path of subagentTranscripts(mainPath)) {
      const agent = basename(path, '.jsonl').replace(/^agent-/, '');
      transcripts.push({
        session,
        isMain: false,
        calls: callsOf(readRecords(path), agent),
      });
    }
  }
  return transcripts;
}

function buildDocs(transcripts, landedAt) {
  const events = new Map();
  for (const { session, calls } of transcripts) {
    for (const call of calls) {
      for (const write of call.writes) {
        if (!events.has(write.doc)) events.set(write.doc, []);
        events.get(write.doc).push({
          timestampMilliseconds: call.timestampMilliseconds,
          kind: write.kind,
          session,
        });
      }
    }
  }
  const docs = [];
  for (const [doc, list] of events) {
    list.sort((a, b) => a.timestampMilliseconds - b.timestampMilliseconds);
    const [first, ...later] = list;
    docs.push({
      doc,
      side: first.timestampMilliseconds < landedAt ? 'before' : 'after',
      firstWrite: new Date(first.timestampMilliseconds).toISOString(),
      firstKind: first.kind,
      sessionIds: [...new Set(list.map((event) => event.session))].sort(),
      editsAfterScaffold: later.filter((event) => event.kind === 'tool').length,
      bashWritesAfterScaffold: later.filter((event) => event.kind === 'bash')
        .length,
    });
  }
  return docs.sort((a, b) => a.firstWrite.localeCompare(b.firstWrite));
}

function buildLintRuns(transcripts, docs, window) {
  const sideOf = new Map(docs.map((entry) => [entry.doc, entry.side]));
  const runs = [];
  for (const { session, calls } of transcripts) {
    let lastWrite = null;
    for (const call of calls) {
      if (call.isLint && lastWrite && call.index - lastWrite.index <= window) {
        runs.push({
          session,
          at: new Date(call.timestampMilliseconds).toISOString(),
          doc: lastWrite.doc,
          side: sideOf.get(lastWrite.doc),
          errors: call.errors,
          warns: call.warns,
        });
      }
      if (call.writes.length > 0)
        lastWrite = { index: call.index, doc: call.writes[0].doc };
    }
  }
  return runs.sort((a, b) => a.at.localeCompare(b.at));
}

const sum = (values) => values.reduce((total, value) => total + value, 0);

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

const mean = (values) =>
  values.length === 0 ? null : sum(values) / values.length;

const round2 = (value) =>
  value === null ? null : Math.round(value * 100) / 100;

function summarize(side, docs, runs) {
  const sideDocs = docs.filter((entry) => entry.side === side);
  const sideRuns = runs.filter((run) => run.side === side);
  const edits = sideDocs.map((entry) => entry.editsAfterScaffold);
  const findings = sum(sideRuns.map((run) => run.errors + run.warns));
  return {
    docs: sideDocs.length,
    sessions: new Set(sideDocs.flatMap((entry) => entry.sessionIds)).size,
    docsEdited: edits.filter((count) => count > 0).length,
    firstByBash: sideDocs.filter((entry) => entry.firstKind === 'bash').length,
    editsMean: round2(mean(edits)),
    editsMedian: median(edits),
    editsTotal: sum(edits),
    bashWritesTotal: sum(
      sideDocs.map((entry) => entry.bashWritesAfterScaffold),
    ),
    lintRuns: sideRuns.length,
    lintErrors: sum(sideRuns.map((run) => run.errors)),
    lintWarns: sum(sideRuns.map((run) => run.warns)),
    runsWithFindings: sideRuns.filter((run) => run.errors + run.warns > 0)
      .length,
    findingsPerRun: round2(
      sideRuns.length === 0 ? null : findings / sideRuns.length,
    ),
  };
}

function formatRows(header, rows) {
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

const show = (value) => (value === null ? '-' : String(value));

function formatReport(docs, sides) {
  const docTable = formatRows(
    ['doc', 'side', 'first-write', 'sessions', 'edits-after', 'bash-after'],
    docs.map((entry) => [
      entry.doc,
      entry.side,
      entry.firstWrite,
      String(entry.sessionIds.length),
      String(entry.editsAfterScaffold),
      String(entry.bashWritesAfterScaffold),
    ]),
  );
  const summaryTable = formatRows(
    [
      'side',
      'docs',
      'sessions',
      'docs-edited',
      'first-by-bash',
      'edits-mean',
      'edits-median',
      'edits-total',
      'bash-total',
      'lint-runs',
      'errors',
      'warns',
      'runs-with-findings',
      'findings-per-run',
    ],
    SIDES.map((side) => {
      const sideSummary = sides[side];
      return [
        side,
        String(sideSummary.docs),
        String(sideSummary.sessions),
        String(sideSummary.docsEdited),
        String(sideSummary.firstByBash),
        show(sideSummary.editsMean),
        show(sideSummary.editsMedian),
        String(sideSummary.editsTotal),
        String(sideSummary.bashWritesTotal),
        String(sideSummary.lintRuns),
        String(sideSummary.lintErrors),
        String(sideSummary.lintWarns),
        String(sideSummary.runsWithFindings),
        show(sideSummary.findingsPerRun),
      ];
    }),
  );
  return `${docTable}\n\n${summaryTable}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const landedAt = Date.parse(options.landed);
  const transcripts = collectTranscripts(options.mains);
  const docs = buildDocs(transcripts, landedAt);
  const lintRuns = buildLintRuns(transcripts, docs, options.lintWindow);
  const sides = Object.fromEntries(
    SIDES.map((side) => [side, summarize(side, docs, lintRuns)]),
  );
  const mainCount = transcripts.filter(
    (transcript) => transcript.isMain,
  ).length;
  console.log(
    `transcripts read: ${mainCount} main, ${transcripts.length - mainCount} subagent\n`,
  );
  console.log(formatReport(docs, sides));
  if (options.json) {
    writeFileSync(
      options.json,
      `${JSON.stringify(
        {
          schema: SCHEMA_VERSION,
          landed: options.landed,
          lintWindow: options.lintWindow,
          docs,
          lintRuns,
          sides,
        },
        null,
        2,
      )}\n`,
    );
  }
}

main();
