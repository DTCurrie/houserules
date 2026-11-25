#!/usr/bin/env node
/**
 * Builds recorded sample directories under `<out>` for proving `score.mjs` without a session:
 * `nested/sample-1` (valid, two orchestrators, two workers, one real revise and one orchestrator
 * `continue` that must not count), `flat/sample-1` (valid, workers spawned by the main session),
 * `nested/sample-2` (acceptance fails on the plain `repo/src`), and `sized/sample-1` (stopped at
 * a ruling with phase 2 not DONE), `flat/sample-2` (valid, its worker's only report is a
 * `task-notification` and a later `SendMessage` is one revise), and `sized/sample-2` (valid in
 * every way but one 680 s gap).
 *
 *   node make-selftest.mjs <out-dir>
 *
 * Exit codes: 0 when the samples were built, 2 on a usage error.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = join(FIXTURE_DIR, '..');
const PLAN_SLUG = 'eval-fixture';
const OVERLAY_PATH = join('skills', 'orchestrate', 'references', 'nested.md');
const EXIT_USAGE = 2;
const BASE_TIME = Date.parse('2026-11-25T10:00:00Z');
const MS_PER_SECOND = 1000;
const SESSION_ID = 'selftest-session';
// Past the scorer's 600 s gap limit, so the sized-2 sample voids as a sleep gap.
const SILENCE_PAST_GAP_LIMIT_SECONDS = 700;

function overlaySha(arm) {
  const bytes = readFileSync(
    join(FIXTURE_DIR, 'arms', arm, 'overlay', OVERLAY_PATH),
  );
  return createHash('sha256').update(bytes).digest('hex');
}

const stamp = (seconds) =>
  new Date(BASE_TIME + seconds * MS_PER_SECOND).toISOString();

function jsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function assistant(seconds, content) {
  return {
    type: 'assistant',
    timestamp: stamp(seconds),
    parent_tool_use_id: null,
    message: { role: 'assistant', content },
  };
}

const text = (value) => ({ type: 'text', text: value });

const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

const spawn = (id, subagentType) =>
  toolUse(id, 'Agent', {
    subagent_type: subagentType,
    description: `spawn ${subagentType}`,
    prompt: 'brief',
  });

function toolResult(seconds, toolUseId, body) {
  return {
    type: 'user',
    timestamp: stamp(seconds),
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [{ type: 'text', text: body }],
        },
      ],
    },
  };
}

const launched = (seconds, toolUseId, agentId) =>
  toolResult(
    seconds,
    toolUseId,
    `Async agent launched successfully.\nagentId: ${agentId} (internal ID)\nThe agent is working in the background.`,
  );

function handBack(seconds, agentId, report) {
  return {
    type: 'user',
    timestamp: stamp(seconds),
    message: {
      role: 'user',
      content: `Another Claude session sent a message:\n<agent-message from="${agentId}">\n[Subagent hand-back]\n  ${report}\n</agent-message>`,
    },
  };
}

function taskNotification(seconds, taskId) {
  return {
    type: 'user',
    timestamp: stamp(seconds),
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_notified</tool-use-id>\n<output-file>/tmp/${taskId}.output</output-file>\n<status>completed</status>\n<summary>Agent completed</summary>\n</task-notification>`,
    },
  };
}

function writeRunJson(dir, arm, sampleNumber) {
  const overlayHash = overlaySha(arm);
  writeFileSync(
    join(dir, 'run.json'),
    `${JSON.stringify(
      {
        arm,
        sample: sampleNumber,
        root: `/private/tmp/selftest/${arm}/sample-${sampleNumber}`,
        model: 'opus',
        validityAgent: null,
        exitCode: 0,
        timedOut: false,
        sessionId: SESSION_ID,
        overlays: [
          {
            path: OVERLAY_PATH,
            initSha256: overlayHash,
            overlaySha256: overlayHash,
            exitSha256: overlayHash,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

/** The dispatcher stream: an init event, the recorded events, then a success result. */
function writeStream(dir, stream, cost, finalText) {
  const lastSeconds = Math.max(
    ...stream.map(
      (record) => (Date.parse(record.timestamp) - BASE_TIME) / MS_PER_SECOND,
    ),
  );
  writeFileSync(
    join(dir, 'stream.jsonl'),
    jsonl([
      {
        type: 'system',
        subtype: 'init',
        session_id: SESSION_ID,
        timestamp: stamp(0),
      },
      ...stream,
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        timestamp: stamp(lastSeconds),
        total_cost_usd: cost,
        session_id: SESSION_ID,
        result: finalText,
        subagent_stats: { by_type: {} },
      },
    ]),
  );
}

function writeSubagents(dir, subagents) {
  const subagentDir = join(dir, 'transcripts', SESSION_ID, 'subagents');
  mkdirSync(subagentDir, { recursive: true });
  for (const [agentId, agentType, records] of subagents) {
    writeFileSync(join(subagentDir, `agent-${agentId}.jsonl`), jsonl(records));
    writeFileSync(
      join(subagentDir, `agent-${agentId}.meta.json`),
      `${JSON.stringify({ agentType })}\n`,
    );
  }
}

/** The collected tree: `src/` layered from each source dir in order, and the plan's ROADMAP. */
function writeTree(dir, src, roadmapStatuses) {
  for (const source of src)
    cpSync(source, join(dir, 'tree', 'src'), { recursive: true });
  const planDir = join(dir, 'tree', '.claude', 'plans', PLAN_SLUG);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(
    join(planDir, 'ROADMAP.md'),
    `# ROADMAP: ${PLAN_SLUG}\n\n## Phases\n\n${roadmapStatuses
      .map(
        (status, index) =>
          `- [ ] **Phase ${index + 1}: step** · Status: ${status} · [sub-plan](phase-${index + 1}.md)`,
      )
      .join('\n')}\n`,
  );
}

function writeSample(
  out,
  arm,
  sampleNumber,
  { stream, subagents, src, roadmapStatuses, cost, orchestrated },
) {
  const dir = join(out, arm, `sample-${sampleNumber}`);
  mkdirSync(dir, { recursive: true });
  writeRunJson(dir, arm, sampleNumber);
  writeStream(dir, stream, cost, orchestrated.finalText);
  writeSubagents(dir, subagents);
  writeTree(dir, src, roadmapStatuses);
}

const out = process.argv[2];
if (!out) {
  console.error('usage: node make-selftest.mjs <out-dir>');
  process.exit(EXIT_USAGE);
}

const PASSING_SRC = [
  join(FIXTURE_DIR, 'repo', 'src'),
  join(EVAL_DIR, 'orchestrate-report', 'solution', 'src'),
  join(FIXTURE_DIR, 'solution', 'src'),
];
const PLAIN_SRC = [join(FIXTURE_DIR, 'repo', 'src')];
const ALL_DONE = ['DONE', 'DONE'];

writeSample(out, 'nested', 1, {
  cost: 1.5,
  src: PASSING_SRC,
  roadmapStatuses: ALL_DONE,
  orchestrated: { finalText: 'PLAN eval-fixture: all phases DONE' },
  stream: [
    assistant(10, [
      spawn('toolu_o1', 'phase-orchestrator'),
      spawn('toolu_o2', 'phase-orchestrator'),
    ]),
    launched(11, 'toolu_o1', 'orch1'),
    launched(12, 'toolu_o2', 'orch2'),
    handBack(90, 'orch1', 'PHASE 1: WAVE_CLOSED'),
    assistant(100, [
      toolUse('toolu_c1', 'SendMessage', { to: 'orch1', message: 'continue' }),
    ]),
    handBack(300, 'orch2', 'PHASE 2: DONE'),
  ],
  subagents: [
    [
      'orch1',
      'phase-orchestrator',
      [
        assistant(20, [spawn('toolu_w1', 'task-worker')]),
        launched(21, 'toolu_w1', 'work1'),
        handBack(60, 'work1', 'SLICE 1a: DONE'),
        assistant(65, [
          toolUse('toolu_r1', 'SendMessage', {
            to: 'work1',
            message: 'fix the failing case',
          }),
        ]),
        handBack(80, 'work1', 'SLICE 1a: DONE'),
      ],
    ],
    [
      'orch2',
      'phase-orchestrator',
      [
        assistant(30, [spawn('toolu_w2', 'task-worker')]),
        launched(31, 'toolu_w2', 'work2'),
        handBack(210, 'work2', 'SLICE 2a: DONE'),
      ],
    ],
    ['work1', 'task-worker', [assistant(25, [text('working')])]],
    ['work2', 'task-worker', [assistant(35, [text('working')])]],
  ],
});

writeSample(out, 'flat', 1, {
  cost: 1.0,
  src: PASSING_SRC,
  roadmapStatuses: ALL_DONE,
  orchestrated: { finalText: 'PLAN eval-fixture: all phases DONE' },
  stream: [
    assistant(10, [
      spawn('toolu_w1', 'task-worker'),
      spawn('toolu_w2', 'task-worker'),
    ]),
    launched(11, 'toolu_w1', 'work1'),
    launched(12, 'toolu_w2', 'work2'),
    handBack(70, 'work1', 'SLICE 1a: DONE'),
    handBack(120, 'work2', 'SLICE 2a: DONE'),
    assistant(180, [text('all phases DONE')]),
  ],
  subagents: [
    ['work1', 'task-worker', [assistant(20, [text('working')])]],
    ['work2', 'task-worker', [assistant(30, [text('working')])]],
  ],
});

writeSample(out, 'flat', 2, {
  cost: 0.8,
  src: PASSING_SRC,
  roadmapStatuses: ALL_DONE,
  orchestrated: { finalText: 'PLAN eval-fixture: all phases DONE' },
  stream: [
    assistant(10, [spawn('toolu_w1', 'task-worker')]),
    launched(11, 'toolu_w1', 'work1'),
    taskNotification(70, 'work1'),
    assistant(80, [
      toolUse('toolu_r1', 'SendMessage', {
        to: 'work1',
        message: 'fix the failing case',
      }),
    ]),
    assistant(150, [text('all phases DONE')]),
  ],
  subagents: [['work1', 'task-worker', [assistant(20, [text('working')])]]],
});

writeSample(out, 'sized', 2, {
  cost: 0.6,
  src: PASSING_SRC,
  roadmapStatuses: ALL_DONE,
  orchestrated: { finalText: 'PLAN eval-fixture: all phases DONE' },
  stream: [
    assistant(10, [spawn('toolu_w1', 'task-worker')]),
    launched(11, 'toolu_w1', 'work1'),
    handBack(20, 'work1', 'SLICE 1a: DONE'),
    assistant(SILENCE_PAST_GAP_LIMIT_SECONDS, [text('all phases DONE')]),
  ],
  subagents: [['work1', 'task-worker', [assistant(15, [text('working')])]]],
});

writeSample(out, 'nested', 2, {
  cost: 0.9,
  src: PLAIN_SRC,
  roadmapStatuses: ALL_DONE,
  orchestrated: { finalText: 'PLAN eval-fixture: all phases DONE' },
  stream: [
    assistant(10, [spawn('toolu_o1', 'phase-orchestrator')]),
    launched(11, 'toolu_o1', 'orch1'),
    handBack(240, 'orch1', 'PHASE 1: DONE'),
  ],
  subagents: [
    ['orch1', 'phase-orchestrator', [assistant(20, [text('working')])]],
  ],
});

writeSample(out, 'sized', 1, {
  cost: 0.4,
  src: PASSING_SRC,
  roadmapStatuses: ['DONE', 'TODO'],
  orchestrated: {
    finalText: 'PHASE 2: NEEDS_RULING, the helpers phase needs a decision',
  },
  stream: [
    assistant(10, [spawn('toolu_o1', 'phase-orchestrator')]),
    launched(11, 'toolu_o1', 'orch1'),
    handBack(100, 'orch1', 'PHASE 2: NEEDS_RULING'),
  ],
  subagents: [
    ['orch1', 'phase-orchestrator', [assistant(20, [text('working')])]],
  ],
});

for (const [arm, sampleNumber] of [
  ['nested', 1],
  ['flat', 1],
  ['flat', 2],
  ['sized', 2],
  ['nested', 2],
  ['sized', 1],
])
  console.log(`built ${join(out, arm, `sample-${sampleNumber}`)}`);
