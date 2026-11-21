import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../health-kit/gather/wait-timeline.mjs', import.meta.url),
);

const SESSION = 'e00f7290-bbb6-4128-9b3b-f53f65bd3e3a';
const ORCHESTRATOR = 'a0a6e9de1fcbfb197';
const SECONDS_TOLERANCE = 1;

const assistantText = (timestamp) => ({
  type: 'assistant',
  timestamp,
  message: { role: 'assistant', content: [{ type: 'text', text: '<text>' }] },
});
const assistantToolUse = (timestamp, id, name, input) => ({
  type: 'assistant',
  timestamp,
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
  },
});
const toolResult = (timestamp, toolUseId, toolUseResult = {}) => ({
  type: 'user',
  timestamp,
  toolUseResult,
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: toolUseId, content: '<output>' },
    ],
  },
});
const system = (timestamp, subtype) => ({ type: 'system', subtype, timestamp });
const inputRecord = (timestamp, origin, text, isMeta) => ({
  type: 'user',
  timestamp,
  isMeta,
  origin,
  message: { role: 'user', content: text },
});
const userInput = (timestamp, origin, text) =>
  inputRecord(timestamp, origin, text, false);
const metaInput = (timestamp, origin, text) =>
  inputRecord(timestamp, origin, text, true);
const notification = (fields) =>
  [
    '<task-notification>',
    ...Object.entries(fields).map(
      ([name, value]) => `<${name}>${value}</${name}>`,
    ),
    '</task-notification>',
  ].join('\n');

const MAIN_RECORDS = [
  metaInput(
    '2026-11-19T20:18:49.033Z',
    { kind: 'peer', from: ORCHESTRATOR, handback: true },
    '<report>',
  ),
  assistantText('2026-11-19T20:18:53.537Z'),
  system('2026-11-19T20:18:57.914Z', 'stop_hook_summary'),
  system('2026-11-19T20:18:57.916Z', 'turn_duration'),
  userInput(
    '2026-11-19T20:18:57.928Z',
    { kind: 'task-notification', producer: 'session-task' },
    notification({
      'task-id': ORCHESTRATOR,
      status: 'completed',
      summary: 'Agent "<description>" finished',
    }),
  ),
  userInput('2026-11-19T20:23:40.208Z', { kind: 'human' }, '<prompt>'),
  metaInput('2026-11-19T20:23:40.251Z', undefined, '<skill body>'),
  assistantToolUse(
    '2026-11-19T20:23:45.569Z',
    'toolu_01T5eoCAb4RKPDaskFjLG56T',
    'SendMessage',
    { to: ORCHESTRATOR, message: '<message>' },
  ),
  toolResult('2026-11-19T20:23:46.019Z', 'toolu_01T5eoCAb4RKPDaskFjLG56T'),
  assistantText('2026-11-19T20:23:48.865Z'),
  system('2026-11-19T20:23:48.924Z', 'turn_duration'),
  assistantText('2026-11-19T20:29:37.741Z'),
  system('2026-11-19T20:29:37.807Z', 'turn_duration'),
  metaInput(
    '2026-11-19T20:32:39.751Z',
    { kind: 'peer', from: ORCHESTRATOR, handback: true },
    '<report>',
  ),
  assistantToolUse(
    '2026-11-19T20:32:45.330Z',
    'toolu_01EhUVDX4KiQJAP5AwjMbrcz',
    'Bash',
    {
      command: 'sleep 60',
      run_in_background: true,
    },
  ),
  toolResult('2026-11-19T20:32:45.452Z', 'toolu_01EhUVDX4KiQJAP5AwjMbrcz', {
    backgroundTaskId: 'bpzggowau',
  }),
  assistantText('2026-11-19T20:32:47.901Z'),
  system('2026-11-19T20:32:47.968Z', 'turn_duration'),
  userInput(
    '2026-11-19T20:33:45.481Z',
    { kind: 'task-notification', producer: 'session-task' },
    notification({
      'task-id': 'bpzggowau',
      'tool-use-id': 'toolu_01EhUVDX4KiQJAP5AwjMbrcz',
      status: 'completed',
      summary: 'Background command "<description>" completed (exit code 0)',
    }),
  ),
  assistantToolUse(
    '2026-11-19T20:33:48.445Z',
    'toolu_01CdMtVteZRREiiVTK24Mna5',
    'Bash',
    {
      command: 'sleep 90',
      run_in_background: true,
    },
  ),
  toolResult('2026-11-19T20:33:48.561Z', 'toolu_01CdMtVteZRREiiVTK24Mna5', {
    backgroundTaskId: 'bd8rcpoan',
  }),
  assistantText('2026-11-19T20:33:49.232Z'),
  system('2026-11-19T20:33:49.290Z', 'turn_duration'),
  userInput(
    '2026-11-19T20:34:05.514Z',
    { kind: 'task-notification', producer: 'session-task' },
    notification({
      'task-id': ORCHESTRATOR,
      status: 'completed',
      summary: 'Agent "<description>" finished',
    }),
  ),
  assistantToolUse(
    '2026-11-19T20:34:06.918Z',
    'toolu_01VRN5SzBFXEV4whY1gV7QE7',
    'SendMessage',
    { to: ORCHESTRATOR, message: '<message>' },
  ),
  toolResult('2026-11-19T20:34:07.451Z', 'toolu_01VRN5SzBFXEV4whY1gV7QE7'),
  assistantText('2026-11-19T20:34:08.811Z'),
  system('2026-11-19T20:34:08.877Z', 'turn_duration'),
];

const ORCHESTRATOR_RECORDS = [
  assistantToolUse(
    '2026-11-19T20:18:48.821Z',
    'toolu_015WJJQ6ZyWYNjJHPRSSL8ov',
    'SubagentHandback',
    { message: '<report>' },
  ),
  toolResult('2026-11-19T20:18:49.014Z', 'toolu_015WJJQ6ZyWYNjJHPRSSL8ov'),
  metaInput('2026-11-19T20:23:46.002Z', { kind: 'coordinator' }, '<message>'),
  assistantToolUse(
    '2026-11-19T20:23:49.256Z',
    'toolu_01BpMY2c8JTxRcMtbKsvGwVL',
    'Bash',
    { command: '<command>' },
  ),
  toolResult('2026-11-19T20:23:49.481Z', 'toolu_01BpMY2c8JTxRcMtbKsvGwVL'),
  assistantToolUse(
    '2026-11-19T20:29:33.657Z',
    'toolu_01RZPQmaEEkKyuuoCcZDZnGx',
    'Bash',
    { command: 'sleep 270', run_in_background: true },
  ),
  toolResult('2026-11-19T20:29:34.004Z', 'toolu_01RZPQmaEEkKyuuoCcZDZnGx', {
    backgroundTaskId: 'bgjcog35p',
  }),
  assistantText('2026-11-19T20:29:34.788Z'),
  assistantToolUse(
    '2026-11-19T20:32:39.599Z',
    'toolu_014DXNFpEbhRoLj1oJvJZptq',
    'SubagentHandback',
    { message: '<report>' },
  ),
  toolResult('2026-11-19T20:32:39.738Z', 'toolu_014DXNFpEbhRoLj1oJvJZptq'),
  metaInput(
    '2026-11-19T20:34:04.037Z',
    { kind: 'task-notification', producer: 'session-task' },
    notification({
      'task-id': 'bgjcog35p',
      'tool-use-id': 'toolu_01RZPQmaEEkKyuuoCcZDZnGx',
      status: 'completed',
      summary: 'Background command "<description>" completed (exit code 0)',
    }),
  ),
  assistantText('2026-11-19T20:34:05.498Z'),
];

function writeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'wait-timeline-'));
  const project = join(root, '-Users-someone-Projects-repo');
  const subagents = join(project, SESSION, 'subagents');
  mkdirSync(subagents, { recursive: true });
  const jsonl = (records) =>
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const mainPath = join(project, `${SESSION}.jsonl`);
  writeFileSync(mainPath, jsonl(MAIN_RECORDS));
  writeFileSync(
    join(subagents, `agent-${ORCHESTRATOR}.jsonl`),
    jsonl(ORCHESTRATOR_RECORDS),
  );
  const sessions = join(root, 'sessions.txt');
  writeFileSync(
    sessions,
    [
      '# path<TAB>bytes<TAB>last-write (UTC).',
      `${mainPath}\t1\t2026-11-19T20:34:05Z`,
      `${join(subagents, `agent-${ORCHESTRATOR}.jsonl`)}\t1\t2026-11-19T20:34:05Z`,
      '',
    ].join('\n'),
  );
  return { root, mainPath, sessions };
}

const KEEPALIVE_SESSION = '2ac79730-92d8-403c-9d44-3b6d8cfd6d3d';
const KEEPALIVE_WAITER = 'a583b49c7e88192a7';
const CHILD_AGENT = 'a30c6a7f1af04ae50';

/** A subagent that reports to main, optionally spawns a background child, then sleeps on a keepalive. */
function keepaliveRecords({ spawnsChild }) {
  const spawn = spawnsChild
    ? [
        assistantToolUse('2026-11-18T23:40:10.000Z', 'toolu_spawn', 'Agent', {
          run_in_background: true,
        }),
        toolResult('2026-11-18T23:40:10.200Z', 'toolu_spawn', {
          agentId: CHILD_AGENT,
          isAsync: true,
        }),
      ]
    : [];
  return [
    assistantToolUse('2026-11-18T23:40:00.000Z', 'toolu_send', 'SendMessage', {
      to: 'main',
    }),
    toolResult('2026-11-18T23:40:00.200Z', 'toolu_send'),
    ...spawn,
    assistantToolUse('2026-11-18T23:40:12.000Z', 'toolu_sleep', 'Bash', {
      command: 'sleep 600',
      run_in_background: true,
    }),
    toolResult('2026-11-18T23:40:12.200Z', 'toolu_sleep', {
      backgroundTaskId: 'bkeepalive',
    }),
    assistantText('2026-11-18T23:40:14.000Z'),
    userInput(
      '2026-11-18T23:50:12.000Z',
      { kind: 'task-notification', producer: 'session-task' },
      notification({
        'task-id': 'bkeepalive',
        'tool-use-id': 'toolu_sleep',
        status: 'completed',
        summary: 'Background command "<description>" completed (exit code 0)',
      }),
    ),
    assistantText('2026-11-18T23:50:14.000Z'),
  ];
}

function writeKeepaliveFixture(records) {
  const root = mkdtempSync(join(tmpdir(), 'wait-timeline-keepalive-'));
  const subagents = join(root, KEEPALIVE_SESSION, 'subagents');
  mkdirSync(subagents, { recursive: true });
  const mainPath = join(root, `${KEEPALIVE_SESSION}.jsonl`);
  writeFileSync(
    mainPath,
    `${JSON.stringify(assistantText('2026-11-18T23:40:00.000Z'))}\n`,
  );
  writeFileSync(
    join(subagents, `agent-${KEEPALIVE_WAITER}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  return { root, mainPath };
}

const MAIN_SESSION = '7d1f0c52-3a9e-4b7e-8c21-5e0a4f6b9d13';

function writeMainFixture(records) {
  const root = mkdtempSync(join(tmpdir(), 'wait-timeline-main-'));
  const mainPath = join(root, `${MAIN_SESSION}.jsonl`);
  writeFileSync(
    mainPath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  return { root, mainPath };
}

const compactSummary = (timestamp) => ({
  ...userInput(timestamp, undefined, '<summary of the earlier conversation>'),
  isCompactSummary: true,
});

function run(args, root) {
  const out = join(root, 'waits.json');
  const result = spawnSync(process.execPath, [SCRIPT, ...args, '--json', out], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout, json: JSON.parse(readFileSync(out, 'utf8')) };
}

function assertWait(actual, context, expected) {
  const { seconds, ...rest } = expected;
  assert.deepEqual(
    { ...actual, seconds: undefined },
    { ...rest, seconds: undefined },
    context,
  );
  assert.ok(
    Math.abs(actual.seconds - seconds) <= SECONDS_TOLERANCE,
    `${context}: seconds ${actual.seconds} not within ${SECONDS_TOLERANCE} of ${seconds}`,
  );
}

describe('wait-timeline', () => {
  it('reproduces the 2026-11-19 stale keepalive and unrelayed finished notice from real timestamps', () => {
    const { root, sessions } = writeFixture();
    const { stdout, json } = run(['--sessions', sessions], root);

    assert.equal(json.schema, 'wait-timeline@2');
    assert.equal(json.waits.length, 5);
    assertWait(
      json.waits[0],
      'the orchestrator waits for continue while main sits on finished',
      {
        session: SESSION,
        waiter: ORCHESTRATOR,
        awaited: 'coordinator',
        start: '2026-11-19T20:18:49.014Z',
        end: '2026-11-19T20:23:46.002Z',
        seconds: 297,
        otherWork: 'no',
        endedBy: 'coordinator',
        charge: 'wait',
      },
    );
    assertWait(
      json.waits[1],
      'main never woke for finished and idled until the user typed',
      {
        session: SESSION,
        waiter: 'main',
        awaited: 'user',
        start: '2026-11-19T20:18:57.916Z',
        end: '2026-11-19T20:23:40.208Z',
        seconds: 282,
        otherWork: 'yes',
        endedBy: 'user',
        charge: 'wait',
      },
    );
    assertWait(
      json.waits[2],
      'main waits for the wave 2 report after a continue',
      {
        session: SESSION,
        waiter: 'main',
        awaited: `report ${ORCHESTRATOR}`,
        start: '2026-11-19T20:29:37.807Z',
        end: '2026-11-19T20:32:39.751Z',
        seconds: 182,
        otherWork: 'no',
        endedBy: `report ${ORCHESTRATOR}`,
        charge: 'wait',
      },
    );
    assertWait(
      json.waits[3],
      'the orchestrator handed back, then sat on its sleep 270 keepalive',
      {
        session: SESSION,
        waiter: ORCHESTRATOR,
        awaited: 'keepalive bgjcog35p',
        start: '2026-11-19T20:32:39.738Z',
        end: '2026-11-19T20:34:04.037Z',
        seconds: 84,
        otherWork: 'no',
        endedBy: 'keepalive bgjcog35p',
        charge: 'wait',
      },
    );
    assertWait(
      json.waits[4],
      'main woke on its own sleep 60 while the finished notice was owed',
      {
        session: SESSION,
        waiter: 'main',
        awaited: `finished ${ORCHESTRATOR}`,
        start: '2026-11-19T20:32:47.968Z',
        end: '2026-11-19T20:33:45.481Z',
        seconds: 57,
        otherWork: 'no',
        endedBy: 'keepalive bpzggowau',
        charge: 'wait',
      },
    );

    const lines = stdout.trimEnd().split('\n');
    assert.equal(lines.length, 6);
    assert.match(
      lines[0],
      /^session\s+waiter\s+awaited\s+start\s+end\s+seconds\s+other-work\s+charge$/,
    );
    assert.match(
      lines[2],
      new RegExp(
        `^${SESSION}\\s+main\\s+user\\s+2026-11-19T20:18:57.916Z\\s+2026-11-19T20:23:40.208Z\\s+282\\.3\\s+yes\\s+wait$`,
      ),
    );
  });

  it('never owes a subagent a report from main after it messages main', () => {
    const { root, mainPath } = writeKeepaliveFixture(
      keepaliveRecords({ spawnsChild: true }),
    );
    const { json } = run([mainPath], root);

    assert.equal(json.waits.length, 1);
    assertWait(json.waits[0], 'the subagent waits on its background child', {
      session: KEEPALIVE_SESSION,
      waiter: KEEPALIVE_WAITER,
      awaited: `report ${CHILD_AGENT}`,
      start: '2026-11-18T23:40:14.000Z',
      end: '2026-11-18T23:50:12.000Z',
      seconds: 598,
      otherWork: 'no',
      endedBy: 'keepalive bkeepalive',
      charge: 'wait',
    });
  });

  it('keeps the timer label when a subagent messaged main and owes nothing', () => {
    const { root, mainPath } = writeKeepaliveFixture(
      keepaliveRecords({ spawnsChild: false }),
    );
    const { json } = run([mainPath], root);

    assert.equal(json.waits.length, 1);
    assert.equal(json.waits[0].awaited, 'keepalive bkeepalive');
  });

  it('reads a user wait after a compaction as having no other work', () => {
    const { root, mainPath } = writeMainFixture([
      assistantText('2026-11-20T10:00:00.000Z'),
      system('2026-11-20T10:00:10.000Z', 'away_summary'),
      system('2026-11-20T10:00:20.000Z', 'compact_boundary'),
      compactSummary('2026-11-20T10:00:30.000Z'),
      userInput('2026-11-20T10:05:00.000Z', { kind: 'human' }, '<prompt>'),
      assistantText('2026-11-20T10:05:02.000Z'),
    ]);
    const { json } = run([mainPath], root);

    assert.equal(json.waits.length, 1);
    assertWait(json.waits[0], 'the compaction summary is not an input', {
      session: MAIN_SESSION,
      waiter: 'main',
      awaited: 'user',
      start: '2026-11-20T10:00:00.000Z',
      end: '2026-11-20T10:05:00.000Z',
      seconds: 300,
      otherWork: 'no',
      endedBy: 'user',
      charge: 'wait',
    });
  });

  it('prints no row for the gap after a tool_result, which is a model call in flight', () => {
    const { root, mainPath } = writeMainFixture([
      assistantToolUse('2026-11-20T10:00:00.000Z', 'toolu_run', 'Bash', {
        command: '<command>',
      }),
      toolResult('2026-11-20T10:00:01.000Z', 'toolu_run'),
      userInput('2026-11-20T10:02:00.000Z', { kind: 'human' }, '<first>'),
      userInput('2026-11-20T10:03:00.000Z', { kind: 'human' }, '<second>'),
      assistantText('2026-11-20T10:03:02.000Z'),
    ]);
    const { json } = run([mainPath], root);

    assert.deepEqual(json.waits, []);
  });

  it('charges a wait ended by an interim notice as runtime and a user wait as wait', () => {
    const { root, mainPath } = writeMainFixture([
      assistantText('2026-11-20T10:00:00.000Z'),
      userInput(
        '2026-11-20T10:02:00.000Z',
        { kind: 'task-notification', producer: 'session-task' },
        notification({
          'task-id': CHILD_AGENT,
          status: 'completed',
          summary: 'Agent "<description>" waiting on its own background work',
        }),
      ),
      assistantText('2026-11-20T10:02:02.000Z'),
      userInput('2026-11-20T10:05:00.000Z', { kind: 'human' }, '<prompt>'),
      assistantText('2026-11-20T10:05:02.000Z'),
    ]);
    const { stdout, json } = run([mainPath], root);

    assert.deepEqual(
      json.waits.map((wait) => [wait.endedBy, wait.charge]),
      [
        [`interim ${CHILD_AGENT}`, 'runtime'],
        ['user', 'wait'],
      ],
    );
    assert.match(stdout.split('\n')[0], /seconds\s+other-work\s+charge$/);
  });

  it('labels the phase-orchestrator keepalive recipe a keepalive and keeps an owed report', () => {
    const recipe =
      'i=0; while [ "$i" -lt 54 ] && grep -qE \'\\|[[:space:]]*(DISPATCHED|REVISING)[[:space:]]*\\|\' .claude/plans/x/phase-1.md; do sleep 5; i=$((i+1)); done';
    const { root, mainPath } = writeKeepaliveFixture([
      assistantToolUse('2026-11-18T23:40:10.000Z', 'toolu_spawn', 'Agent', {
        run_in_background: true,
      }),
      toolResult('2026-11-18T23:40:10.200Z', 'toolu_spawn', {
        agentId: CHILD_AGENT,
        isAsync: true,
      }),
      assistantToolUse('2026-11-18T23:40:12.000Z', 'toolu_loop', 'Bash', {
        command: recipe,
        run_in_background: true,
      }),
      toolResult('2026-11-18T23:40:12.200Z', 'toolu_loop', {
        backgroundTaskId: 'bloop',
      }),
      assistantText('2026-11-18T23:40:14.000Z'),
      userInput(
        '2026-11-18T23:44:42.000Z',
        { kind: 'task-notification', producer: 'session-task' },
        notification({
          'task-id': 'bloop',
          'tool-use-id': 'toolu_loop',
          status: 'completed',
          summary: 'Background command "<description>" completed (exit code 0)',
        }),
      ),
      assistantText('2026-11-18T23:44:44.000Z'),
    ]);
    const { json } = run([mainPath], root);

    assert.equal(json.waits.length, 1);
    assert.equal(json.waits[0].endedBy, 'keepalive bloop');
    assert.equal(json.waits[0].awaited, `report ${CHILD_AGENT}`);
  });

  it('keeps a wait loop that runs a test beside its sleep as a background command', () => {
    const { root, mainPath } = writeKeepaliveFixture([
      assistantToolUse('2026-11-18T23:40:12.000Z', 'toolu_loop', 'Bash', {
        command:
          'i=0; while [ "$i" -lt 54 ]; do pnpm test; sleep 5; i=$((i+1)); done',
        run_in_background: true,
      }),
      toolResult('2026-11-18T23:40:12.200Z', 'toolu_loop', {
        backgroundTaskId: 'bloop',
      }),
      assistantText('2026-11-18T23:40:14.000Z'),
      userInput(
        '2026-11-18T23:44:42.000Z',
        { kind: 'task-notification', producer: 'session-task' },
        notification({
          'task-id': 'bloop',
          'tool-use-id': 'toolu_loop',
          status: 'completed',
          summary: 'Background command "<description>" completed (exit code 0)',
        }),
      ),
      assistantText('2026-11-18T23:44:44.000Z'),
    ]);
    const { json } = run([mainPath], root);

    assert.equal(json.waits[0].endedBy, 'background bloop');
  });

  it('prints no row when every wait is under the threshold', () => {
    const { root, mainPath } = writeFixture();
    const { stdout, json } = run(['--min-seconds', '300', mainPath], root);

    assert.deepEqual(json.waits, []);
    assert.equal(stdout.trimEnd().split('\n').length, 1);
  });

  it('exits 2 with a usage line when no transcript is given', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^usage: node wait-timeline\.mjs/m);
  });
});
