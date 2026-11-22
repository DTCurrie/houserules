// Cases for one eval slice. `scripts/__tests__/eval.test.mjs` imports this file.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  judgeValidity,
  loadSample,
  PREDICATES,
  verdict,
} from '../orchestrate-report.mjs';

const DONE_REPORT = `PHASE eval-fixture/1: DONE

Status table
| Slice | State | Note |
| 1a | DONE | |

Landed
- 1a: add()

Verify
pass

Rulings made
- none

Backlogged
- none

Out of scope
- none

Requests
- none

Decide candidates
- none

Resume
nothing, the phase is closed
`;

const HASH_REPORT = `
## PHASE eval-fixture/1: WAVE_CLOSED 1/2

## Status table
| 1a | DONE |

## Landed
- 1a: sum

### Verify
not run, the phase is open

## Rulings made
- none

## Backlogged
- none

## Out of scope
- none

## Requests
- none

## Decide candidates
- none

## Resume
continue resumes wave 2
`.replace(/^## PHASE/m, 'PHASE');

const BOLD_REPORT = [
  'PHASE eval-fixture/1: NEEDS_RULING',
  '',
  '**Status table:**',
  '| 1a | BLOCKED |',
  '**Landed:**',
  '- none',
  '**Verify:**',
  'not run',
  '**Ruling needed:**',
  'Which seam?',
  '**Rulings made:**',
  '- none',
  '**Backlogged:**',
  '- none',
  '**Out of scope:**',
  '- none',
  '**Requests:**',
  '- none',
  '**Decide candidates:**',
  '- none',
  '**Resume:**',
  'a Ruling: line resumes 1a',
].join('\r\n');

const WORKER_REPLY = `SLICE 1a: DONE

Files
- src/add.js — add()

Acceptance
$ node --test test/add.test.js
# pass 2
# fail 0

Deviations
- none

Requests
- none

Out of scope
- none
`;

function assistant(...content) {
  return { type: 'assistant', message: { role: 'assistant', content } };
}

const text = (body) => ({ type: 'text', text: body });
const bash = (command) => ({
  type: 'tool_use',
  name: 'Bash',
  input: { command },
});

function worker(agentId, reply, commands = ['node --test test/add.test.js']) {
  return {
    agentId,
    agentType: 'task-worker',
    records: [
      assistant(text('Reading the brief.')),
      ...commands.map((command) => assistant(bash(command))),
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'ok' }] },
      },
      assistant(text(reply)),
    ],
  };
}

function orchestrator(report) {
  return {
    agentId: 'po1',
    agentType: 'phase-orchestrator',
    records: [
      assistant(text('Slicing phase 1.')),
      assistant({
        type: 'tool_use',
        name: 'SubagentHandback',
        input: { message: report },
      }),
    ],
  };
}

const INTACT_TREE = Object.freeze({
  acceptances: { add: 0, sum: 0, mean: 0 },
  roadmapPhase1: '| 1 | [phase-1](phase-1.md) | DONE |',
  decoyIntact: { 'ROADMAP.md': true, 'phase-1.md': true },
  hasDecoyJs: false,
});

/**
 * One loaded session, shaped like a valid named-plan sample's artifacts unless overridden.
 *
 * @param {object} [options]
 */
function sample({
  label = 'sample-1',
  preface = 'Resolved plan eval-fixture, phase 1.',
  report = DONE_REPORT,
  reportInStream = false,
  workers = [worker('w1', WORKER_REPLY)],
  byType = { 'phase-orchestrator': 1, 'task-worker': 3 },
  leftTree = INTACT_TREE,
  run = true,
} = {}) {
  const stream = [
    { type: 'system', subtype: 'init', session_id: 's1' },
    {
      ...assistant(...(preface ? [text(preface)] : []), {
        type: 'tool_use',
        id: 't1',
        name: 'Agent',
        input: { subagent_type: 'phase-orchestrator' },
      }),
      parent_tool_use_id: null,
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [text(reportInStream ? report : 'agent finished')],
          },
        ],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 2.4,
      subagent_stats: { by_type: byType },
    },
  ];
  return {
    label,
    run: run
      ? { sample: 1, exitCode: 0, timedOut: false, sessionId: 's1', leftTree }
      : null,
    stream,
    subagents: [...(reportInStream ? [] : [orchestrator(report)]), ...workers],
  };
}

const judge = (id, session) => PREDICATES[id](session).result;

describe('predicates: validity', () => {
  test('a sample with a phase-orchestrator and a clean success result is valid', () => {
    assert.equal(judgeValidity(sample()).valid, true);
  });

  test('a sample with no phase-orchestrator is void', () => {
    const verdictLine = judgeValidity(
      sample({ byType: { 'general-purpose': 1 } }),
    );
    assert.equal(verdictLine.valid, false);
    assert.match(verdictLine.line, /^sample-1: void, no phase-orchestrator/);
  });

  test('a sample with no run.json is void', () => {
    assert.equal(judgeValidity(sample({ run: false })).valid, false);
  });

  test('a budget-stopped result is void', () => {
    const session = sample();
    session.stream[3] = {
      type: 'result',
      subtype: 'error_max_budget_usd',
      is_error: true,
    };
    assert.equal(judgeValidity(session).valid, false);
  });
});

describe('predicates: loadSample', () => {
  const root = mkdtempSync(join(tmpdir(), 'hr-eval-predicates-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  test('an empty session directory loads and is void', () => {
    const dir = join(root, 'sample-2');
    mkdirSync(dir);
    const loaded = loadSample(dir);
    assert.deepEqual(loaded, {
      label: 'sample-2',
      run: null,
      stream: [],
      subagents: [],
    });
    assert.equal(judgeValidity(loaded).valid, false);
  });

  test('a session directory on disk judges like its in-memory shape', () => {
    const dir = join(root, 'no-slug');
    const built = sample({ label: 'no-slug' });
    const subagents = join(dir, 'transcripts', 's1', 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(built.run));
    writeFileSync(
      join(dir, 'stream.jsonl'),
      `${built.stream.map((event) => JSON.stringify(event)).join('\r\n')}\r\n{"type":"assist`,
    );
    writeFileSync(join(dir, 'transcripts', 's1.jsonl'), '');
    for (const agent of built.subagents) {
      const lines = agent.records
        .map((record) => JSON.stringify(record))
        .join('\n');
      writeFileSync(
        join(subagents, `agent-${agent.agentId}.jsonl`),
        `${lines}\n`,
      );
      const meta = { agentType: agent.agentType };
      if (agent.agentType === 'task-worker') meta.parentAgentId = 'po1';
      writeFileSync(
        join(subagents, `agent-${agent.agentId}.meta.json`),
        JSON.stringify(meta),
      );
    }
    const loaded = loadSample(dir);
    assert.equal(loaded.label, 'no-slug');
    assert.equal(loaded.stream.length, 4);
    assert.deepEqual(
      loaded.subagents.map((agent) => [agent.agentId, agent.agentType]),
      [
        ['po1', 'phase-orchestrator'],
        ['w1', 'task-worker'],
      ],
    );
    assert.equal(judgeValidity(loaded).valid, true);
    for (const id of Object.keys(PREDICATES))
      assert.equal(judge(id, loaded), 'pass', id);
  });
});

describe('predicates: orch-042', () => {
  test('a DONE report without Ruling needed passes', () => {
    assert.equal(judge('orch-042', sample()), 'pass');
  });

  test('sections out of order fail', () => {
    const swapped = DONE_REPORT.replace(
      'Landed\n- 1a: add()\n\nVerify\npass',
      'Verify\npass\n\nLanded\n- 1a: add()',
    );
    const result = PREDICATES['orch-042'](sample({ report: swapped }));
    assert.equal(result.result, 'fail');
    assert.match(
      result.line,
      /Verify heading before Landed|Landed heading before/,
    );
  });

  test('hash headings pass, read from the tool_result in the stream', () => {
    assert.equal(
      judge('orch-042', sample({ report: HASH_REPORT, reportInStream: true })),
      'pass',
    );
  });

  test('bold headings with a colon and CRLF line ends pass on a NEEDS_RULING report', () => {
    assert.equal(judge('orch-042', sample({ report: BOLD_REPORT })), 'pass');
  });

  test('a NEEDS_RULING report without Ruling needed fails', () => {
    const report = DONE_REPORT.replace('DONE\n', 'NEEDS_RULING\n');
    assert.equal(judge('orch-042', sample({ report })), 'fail');
  });

  test('a first line naming another plan fails', () => {
    const report = DONE_REPORT.replace('eval-fixture/1', 'decoy/1');
    assert.equal(judge('orch-042', sample({ report })), 'fail');
  });

  test('a missing section fails', () => {
    const report = DONE_REPORT.replace('Backlogged\n- none\n', '');
    assert.equal(judge('orch-042', sample({ report })), 'fail');
  });
});

describe('predicates: orch-001', () => {
  test('workers spawned, phase 1 DONE, acceptances green, and no diff passes', () => {
    assert.equal(judge('orch-001', sample()), 'pass');
  });

  test('a report holding a hunk header fails', () => {
    const report = DONE_REPORT.replace(
      '- 1a: add()',
      '- 1a: add()\n@@ -1,3 +1,4 @@',
    );
    assert.equal(judge('orch-001', sample({ report })), 'fail');
  });

  test('a ROADMAP phase 1 line still IN PROGRESS fails', () => {
    const leftTree = {
      ...INTACT_TREE,
      roadmapPhase1: '| 1 | phase-1 | IN PROGRESS |',
    };
    assert.equal(judge('orch-001', sample({ leftTree })), 'fail');
  });

  test('a red acceptance on the rerun fails', () => {
    const leftTree = {
      ...INTACT_TREE,
      acceptances: { add: 0, sum: 1, mean: 0 },
    };
    assert.equal(judge('orch-001', sample({ leftTree })), 'fail');
  });

  test('no task-worker spawned fails', () => {
    const session = sample({
      workers: [],
      byType: { 'phase-orchestrator': 1 },
    });
    assert.equal(judge('orch-001', session), 'fail');
  });
});

describe('predicates: orch-071', () => {
  test('naming eval-fixture and phase 1 before the Agent call, decoy intact, passes', () => {
    assert.equal(judge('orch-071', sample({ label: 'no-slug' })), 'pass');
  });

  test('a no-slug dispatcher that names decoy fails', () => {
    const session = sample({
      label: 'no-slug',
      preface: 'Resolving to plan decoy, Phase 1.',
    });
    assert.equal(judge('orch-071', session), 'fail');
  });

  test('a changed decoy plan file fails', () => {
    const leftTree = {
      ...INTACT_TREE,
      decoyIntact: { 'ROADMAP.md': false, 'phase-1.md': true },
    };
    assert.equal(
      judge('orch-071', sample({ label: 'no-slug', leftTree })),
      'fail',
    );
  });

  test('a written src/decoy.js fails', () => {
    const leftTree = { ...INTACT_TREE, hasDecoyJs: true };
    assert.equal(judge('orch-071', sample({ leftTree })), 'fail');
  });

  test('no statement before the first Agent call fails', () => {
    assert.equal(judge('orch-071', sample({ preface: null })), 'fail');
  });

  test('bold emphasis around the plan and phase passes', () => {
    const session = sample({
      preface:
        'Resolved plan **eval-fixture**, phase **1 (helpers)** — the only `IN PROGRESS` roadmap.',
    });
    assert.equal(judge('orch-071', session), 'pass');
  });

  test('a statement in its own event, after a Bash call and before the Agent event, passes', () => {
    const session = sample({ preface: null });
    session.stream.splice(
      1,
      0,
      {
        ...assistant({ type: 'thinking', thinking: '' }),
        parent_tool_use_id: null,
      },
      { ...assistant(bash('cat ROADMAP.md')), parent_tool_use_id: null },
      {
        ...assistant(text('Resolved plan _eval-fixture_, phase `1`.')),
        parent_tool_use_id: null,
      },
    );
    assert.equal(judge('orch-071', session), 'pass');
  });

  test('a statement only after the first Agent call fails', () => {
    const session = sample({ preface: null });
    session.stream.push(
      assistant(text('Plan eval-fixture phase 1 is running.')),
    );
    assert.equal(judge('orch-071', session), 'fail');
  });
});

describe('predicates: agent-062', () => {
  test('a reply with the SLICE line and five headings in order passes', () => {
    const hashed = WORKER_REPLY.replace(
      /^(Files|Acceptance|Deviations|Requests|Out of scope)$/gm,
      '### $1',
    );
    const workers = [
      worker('w1', WORKER_REPLY),
      worker('w2', hashed.replaceAll('\n', '\r\n')),
    ];
    assert.equal(judge('agent-062', sample({ workers })), 'pass');
  });

  test('a worker reply with a diff --git line fails', () => {
    const reply = WORKER_REPLY.replace(
      '- src/add.js — add()',
      '- src/add.js\ndiff --git a/src/add.js b/src/add.js',
    );
    const result = PREDICATES['agent-062'](
      sample({ workers: [worker('w1', WORKER_REPLY), worker('w2', reply)] }),
    );
    assert.equal(result.result, 'fail');
    assert.match(result.line, /w2/);
  });

  test('a reply with no SLICE line fails', () => {
    const reply = `Done.\n\n${WORKER_REPLY}`;
    assert.equal(
      judge('agent-062', sample({ workers: [worker('w1', reply)] })),
      'fail',
    );
  });

  test('the SubagentHandback message is the reply over a later assistant text', () => {
    const agent = worker('w1', 'all done, see above');
    agent.records.splice(
      2,
      0,
      assistant({
        type: 'tool_use',
        name: 'SubagentHandback',
        input: { message: WORKER_REPLY },
      }),
    );
    assert.equal(judge('agent-062', sample({ workers: [agent] })), 'pass');
  });
});

describe('predicates: agent-059', () => {
  test('a command that ran and shows output passes', () => {
    assert.equal(judge('agent-059', sample()), 'pass');
  });

  test('an Acceptance section with a $ line and no output fails', () => {
    const reply = WORKER_REPLY.replace('# pass 2\n# fail 0\n', '');
    assert.equal(
      judge('agent-059', sample({ workers: [worker('w1', reply)] })),
      'fail',
    );
  });

  test('a reply with no Acceptance section fails', () => {
    const reply = WORKER_REPLY.replace(
      /Acceptance\n[\s\S]*?\nDeviations/,
      'Deviations',
    );
    assert.equal(
      judge('agent-059', sample({ workers: [worker('w1', reply)] })),
      'fail',
    );
  });

  test('a reported command run inside a longer Bash call fails that worker', () => {
    const ran = ['cd ../..; node --test test/add.test.js 2>&1 | tail -12'];
    const result = PREDICATES['agent-059'](
      sample({
        workers: [worker('w1', WORKER_REPLY), worker('w2', WORKER_REPLY, ran)],
      }),
    );
    assert.equal(result.result, 'fail');
    assert.match(
      result.line,
      /w2 \$ node --test test\/add\.test\.js matches no Bash/,
    );
  });

  test('a reported command run exactly in any one Bash call passes', () => {
    const ran = [
      'cd ../..; node --test test/add.test.js 2>&1 | tail -12',
      'node --test test/add.test.js',
      'git status --short',
    ];
    assert.equal(
      judge(
        'agent-059',
        sample({ workers: [worker('w1', WORKER_REPLY, ran)] }),
      ),
      'pass',
    );
  });

  test('every $ command of a reply must match, not only the first', () => {
    const twoCommands = WORKER_REPLY.replace(
      '# fail 0\n',
      '# fail 0\n$ node --test test/sum.test.js\n# pass 1\n',
    );
    const ran = ['node --test test/add.test.js'];
    const result = PREDICATES['agent-059'](
      sample({ workers: [worker('w1', twoCommands, ran)] }),
    );
    assert.equal(result.result, 'fail');
    assert.match(result.line, /sum\.test\.js/);
  });

  const reply = WORKER_REPLY.replace(
    '$ node --test test/add.test.js',
    '$ node --test',
  );
  for (const [ran, expected] of [
    ['node --test', 'pass'],
    ['cd /tmp/s && node --test', 'pass'],
    ['node --test | tail -5', 'fail'],
    ['cd ../..; node --test | tail -12', 'fail'],
    ['cd src/text\ncat > index.js <<EOF\nEOF\ncd ../..; node --test', 'fail'],
  ]) {
    test(`$ node --test against the transcript command ${ran} reads ${expected}`, () => {
      assert.equal(
        judge('agent-059', sample({ workers: [worker('w1', reply, [ran])] })),
        expected,
      );
    });
  }

  const MULTI_LINE_CALL =
    "cd src/text\ncat > index.js <<'EOF'\nexport const x = 1;\nEOF\ncd ../..; node --test";
  const lineForLine = (output) =>
    WORKER_REPLY.replace(
      '$ node --test test/add.test.js\n# pass 2\n# fail 0\n',
      `$ cd src/text\ncat > index.js <<'EOF'\nexport const x = 1;\nEOF\ncd ../..; node --test\n${output}`,
    );

  test('a multi-line command reported line for line with output passes', () => {
    const text = lineForLine('# pass 2\n# fail 0\n');
    assert.equal(
      judge(
        'agent-059',
        sample({ workers: [worker('w1', text, [MULTI_LINE_CALL])] }),
      ),
      'pass',
    );
  });

  test('a multi-line command reported line for line with no output fails', () => {
    const result = PREDICATES['agent-059'](
      sample({
        workers: [worker('w1', lineForLine(''), [MULTI_LINE_CALL])],
      }),
    );
    assert.equal(result.result, 'fail');
    assert.match(result.line, /has no output line/);
  });

  test('a multi-line command reported line for line against a call with a tail appended fails', () => {
    const text = lineForLine('# pass 2\n# fail 0\n');
    const ran = `${MULTI_LINE_CALL} 2>&1 | tail -12`;
    assert.equal(
      judge('agent-059', sample({ workers: [worker('w1', text, [ran])] })),
      'fail',
    );
  });

  test('a one-line command whose first output line starts with > passes', () => {
    const text = WORKER_REPLY.replace(
      '# pass 2\n',
      '> test output\n# pass 2\n',
    );
    assert.equal(
      judge(
        'agent-059',
        sample({
          workers: [worker('w1', text, ['node --test test/add.test.js'])],
        }),
      ),
      'pass',
    );
  });
});

describe('predicates: no task-worker reply', () => {
  test('both worker claims give no result, never a pass', () => {
    const silent = {
      agentId: 'w1',
      agentType: 'task-worker',
      records: [assistant(bash('ls'))],
    };
    for (const workers of [[], [silent]]) {
      assert.equal(judge('agent-059', sample({ workers })), null);
      assert.equal(judge('agent-062', sample({ workers })), null);
    }
  });
});

describe('verdict', () => {
  const three = () => [1, 2, 3].map((k) => sample({ label: `sample-${k}` }));
  const voidSample = (label) => sample({ label, byType: {} });

  test('three passing samples and no no-slug session read orch-071 INCONCLUSIVE', () => {
    const { claims, exitCode } = verdict({ samples: three(), noSlug: null });
    assert.equal(claims['orch-071'], 'INCONCLUSIVE');
    assert.equal(claims['orch-042'], 'PASS');
    assert.equal(exitCode, 2);
  });

  test('three passing samples and a passing no-slug session read every claim PASS', () => {
    const { claims, lines, exitCode } = verdict({
      samples: three(),
      noSlug: sample({ label: 'no-slug' }),
    });
    assert.deepEqual(Object.keys(claims), [
      'agent-059',
      'agent-062',
      'orch-001',
      'orch-042',
      'orch-071',
    ]);
    assert.ok(Object.values(claims).every((claim) => claim === 'PASS'));
    assert.equal(lines['orch-071'].length, 4);
    assert.match(lines['orch-071'][3], /^no-slug: pass, /);
    assert.equal(exitCode, 0);
  });

  test('one FAIL claim and one INCONCLUSIVE claim exit 1', () => {
    const samples = three();
    samples[1] = sample({
      label: 'sample-2',
      report: DONE_REPORT.replace('Resume\n', ''),
    });
    const { claims, exitCode } = verdict({ samples, noSlug: null });
    assert.equal(claims['orch-042'], 'FAIL');
    assert.equal(claims['orch-071'], 'INCONCLUSIVE');
    assert.equal(exitCode, 1);
  });

  test('a failing no-slug session makes FAIL', () => {
    const noSlug = sample({
      label: 'no-slug',
      preface: 'Taking decoy, phase 1.',
    });
    const { claims, exitCode } = verdict({ samples: three(), noSlug });
    assert.equal(claims['orch-071'], 'FAIL');
    assert.equal(exitCode, 1);
  });

  test('a void sample never turns a PASS into a FAIL', () => {
    const samples = [...three(), voidSample('sample-4')];
    const { claims, lines } = verdict({
      samples,
      noSlug: sample({ label: 'no-slug' }),
    });
    assert.ok(Object.values(claims).every((claim) => claim === 'PASS'));
    assert.match(lines['orch-042'][3], /^sample-4: void, /);
  });

  test('a void sample never counts toward the three', () => {
    const samples = [
      sample({ label: 'sample-1' }),
      voidSample('sample-2'),
      sample({ label: 'sample-3' }),
    ];
    const { claims, exitCode } = verdict({
      samples,
      noSlug: sample({ label: 'no-slug' }),
    });
    assert.ok(Object.values(claims).every((claim) => claim === 'INCONCLUSIVE'));
    assert.equal(exitCode, 2);
  });

  test('a void no-slug session leaves orch-071 INCONCLUSIVE', () => {
    const { claims } = verdict({
      samples: three(),
      noSlug: voidSample('no-slug'),
    });
    assert.equal(claims['orch-071'], 'INCONCLUSIVE');
    assert.equal(claims['orch-001'], 'PASS');
  });

  test('a valid sample with no worker reply leaves the worker claims INCONCLUSIVE', () => {
    const samples = [...three(), sample({ label: 'sample-4', workers: [] })];
    const { claims } = verdict({
      samples,
      noSlug: sample({ label: 'no-slug' }),
    });
    assert.equal(claims['agent-059'], 'INCONCLUSIVE');
    assert.equal(claims['agent-062'], 'INCONCLUSIVE');
    assert.equal(claims['orch-042'], 'PASS');
  });
});
