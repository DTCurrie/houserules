import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  KIND_NAMES,
  classify,
  readAgentType,
  summarize,
} from '../health-kit/gather/waste-audit.mjs';

const SCRIPT = fileURLToPath(
  new URL('../health-kit/gather/waste-audit.mjs', import.meta.url),
);

const MODEL = 'claude-sonnet-5-5-20261001';
const BASE = Date.parse('2026-11-20T00:00:00Z');
const USAGE = { input_tokens: 1_000_000, output_tokens: 100_000 };

let toolUseCounter = 0;
const iso = (sec) => new Date(BASE + sec * 1000).toISOString();

const userRecord = (sec, content) => ({
  type: 'user',
  timestamp: iso(sec),
  message: { role: 'user', content },
});

const assistantRecord = (sec, id, blocks, usage) => ({
  type: 'assistant',
  timestamp: iso(sec),
  message: { id, model: MODEL, role: 'assistant', content: blocks, usage },
});

const call = (name, input, output = 'ok') => ({ name, input, output });
const step = (...calls) => ({ calls });
const splitStep = (...calls) => ({ calls, split: true });
const note = (text) => ({ note: text });
const metaNote = (text) => ({ note: text, isMeta: true });
const textOnly = () => ({ textOnly: true });
const boundary = () => ({ boundary: true });

function transcript(firstText, steps, usage = USAGE) {
  const records = [userRecord(0, firstText)];
  steps.forEach((entry, index) => {
    const sec = 2 * index + 1;
    const id = `msg_${index}`;
    if (entry.note !== undefined) {
      const record = userRecord(sec + 1, entry.note);
      records.push(entry.isMeta ? { ...record, isMeta: true } : record);
      return;
    }
    if (entry.boundary) {
      records.push({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: iso(sec),
      });
      return;
    }
    if (entry.textOnly) {
      records.push(
        assistantRecord(sec, id, [{ type: 'text', text: 'done' }], usage),
      );
      return;
    }
    const uses = entry.calls.map((spec) => ({
      type: 'tool_use',
      id: `toolu_${(toolUseCounter += 1)}`,
      name: spec.name,
      input: spec.input,
    }));
    if (entry.split)
      for (const use of uses)
        records.push(assistantRecord(sec, id, [use], usage));
    else records.push(assistantRecord(sec, id, uses, usage));
    records.push(
      userRecord(
        sec + 1,
        uses.map((use, i) => ({
          type: 'tool_result',
          tool_use_id: use.id,
          content: entry.calls[i].output,
        })),
      ),
    );
  });
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

const reads = (count, prefix = 'f') =>
  Array.from({ length: count }, (_, i) =>
    step(call('Read', { file_path: `/r/${prefix}${i}.ts` })),
  );

function withFirstRecordFields(text, fields) {
  const [first, ...rest] = text.split('\n');
  return [JSON.stringify({ ...JSON.parse(first), ...fields }), ...rest].join(
    '\n',
  );
}

function episodes(text, kind, fileName = '/t/session.jsonl') {
  const result = summarize([classify(text, fileName)]);
  return result.kinds.find((entry) => entry.kind === kind);
}

function assertNone(text, kind, fileName) {
  const found = episodes(text, kind, fileName);
  assert.equal(found.count, 0);
  assert.equal(found.calls, 0);
  assert.deepEqual(found.pointers, []);
}

describe('rerun-unchanged', () => {
  const pnpmTest = call('Bash', { command: 'pnpm test' });

  it('matches a repeated check command with no write between, ignoring whitespace', () => {
    const text = transcript(
      'hi',
      [pnpmTest, call('Bash', { command: 'pnpm   test\n' })].map((spec) =>
        step(spec),
      ),
    );
    const found = episodes(text, 'rerun-unchanged');
    assert.equal(found.count, 1);
    assert.equal(found.calls, 1);
    assert.equal(found.costUsd, 3);
    assert.equal(found.wallSeconds, 2);
    assert.deepEqual(found.pointers, ['/t/session.jsonl:4']);
  });

  it('rejects a rerun after an Edit', () => {
    const text = transcript('hi', [
      step(pnpmTest),
      step(call('Edit', { file_path: '/r/a.ts' })),
      step(pnpmTest),
    ]);
    assertNone(text, 'rerun-unchanged');
  });

  it('rejects a repeated command that is not a check', () => {
    const ls = call('Bash', { command: 'ls -la' });
    assertNone(transcript('hi', [step(ls), step(ls)]), 'rerun-unchanged');
  });

  it('rejects a run after an attempt the auto mode classifier blocked', () => {
    const blocked = call(
      'Bash',
      { command: 'pnpm --filter @houserules/cli test' },
      'The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash. You may try the action again once, as-is.',
    );
    const text = transcript('hi', [
      step(blocked),
      step(call('Bash', { command: 'pnpm --filter @houserules/cli test' })),
    ]);

    assertNone(text, 'rerun-unchanged');
  });

  const keepaliveCommand = readFileSync(
    new URL(
      '../../packages/cli/payload/agents/phase-orchestrator.md',
      import.meta.url,
    ),
    'utf8',
  )
    .split('\n')
    .find((line) => line.startsWith('i=0; while'))
    .replace('<sub-plan>', '.claude/plans/x/phase-3-plan-lint-checks.md');

  it('rejects two identical keepalive launches in the background', () => {
    const launch = call('Bash', {
      command: keepaliveCommand,
      run_in_background: true,
    });

    assertNone(
      transcript('hi', [step(launch), step(launch)]),
      'rerun-unchanged',
    );
  });

  it('still matches two identical keepalive commands run in the foreground', () => {
    const launch = call('Bash', { command: keepaliveCommand });

    const found = episodes(
      transcript('hi', [step(launch), step(launch)]),
      'rerun-unchanged',
    );

    assert.equal(found.count, 1);
  });
});

describe('reread-unchanged', () => {
  const readA = call('Read', { file_path: '/r/a.ts', offset: 10, limit: 50 });

  it('matches a Read with the same path, offset, and limit', () => {
    const text = transcript('hi', [
      step(readA),
      step(call('Read', { file_path: '/r/b.ts' })),
      step(readA),
    ]);
    const found = episodes(text, 'reread-unchanged');
    assert.equal(found.count, 1);
    assert.equal(found.calls, 1);
    assert.deepEqual(found.pointers, ['/t/session.jsonl:6']);
  });

  it('rejects a different range and a Read after an Edit to the same path', () => {
    const otherRange = call('Read', {
      file_path: '/r/a.ts',
      offset: 60,
      limit: 50,
    });
    assertNone(
      transcript('hi', [step(readA), step(otherRange)]),
      'reread-unchanged',
    );
    assertNone(
      transcript('hi', [
        step(readA),
        step(call('Edit', { file_path: '/r/a.ts' })),
        step(readA),
      ]),
      'reread-unchanged',
    );
  });

  it('rejects a Read repeated across a compaction boundary', () => {
    const text = transcript('hi', [step(readA), boundary(), step(readA)]);

    assertNone(text, 'reread-unchanged');
  });

  it('rejects a background task output file read twice with no write', () => {
    const readOutput = call('Read', {
      file_path: '/private/tmp/claude-501/proj/tasks/b7f3k2.output',
    });

    const text = transcript('hi', [step(readOutput), step(readOutput)]);

    assertNone(text, 'reread-unchanged');
  });

  it('still matches a plain path read twice with no boundary between', () => {
    const readPlain = call('Read', { file_path: '/r/plain.ts' });

    const found = episodes(
      transcript('hi', [step(readPlain), step(readPlain)]),
      'reread-unchanged',
    );

    assert.equal(found.count, 1);
  });
});

describe('ask-to-act-gap', () => {
  const edit = call('Edit', { file_path: '/r/a.ts' });

  it('matches eight calls between a request and the first edit, with a split parallel request', () => {
    const text = transcript('please fix the parser', [
      splitStep(
        call('Read', { file_path: '/r/p.ts' }),
        call('Read', { file_path: '/r/q.ts' }),
      ),
      ...reads(6),
      step(edit),
    ]);
    const found = episodes(text, 'ask-to-act-gap');
    assert.equal(found.count, 1);
    assert.equal(found.calls, 8);
    assert.equal(found.costUsd, 21);
    assert.equal(found.wallSeconds, 14);
    assert.deepEqual(found.pointers, ['/t/session.jsonl:2']);
  });

  it('rejects the same sequence in a subagent transcript, where the first message is a brief', () => {
    const text = transcript('please fix the parser', [...reads(8), step(edit)]);

    assert.equal(episodes(text, 'ask-to-act-gap').count, 1);
    assertNone(text, 'ask-to-act-gap', '/p/sess/subagents/agent-1.jsonl');
  });

  it('counts calls covered by a plan-project fire once, under plan-read-before-write', () => {
    const text = transcript('please create the plan', [
      step(call('Skill', { skill: 'plan-project' })),
      ...reads(10),
      step(call('Write', { file_path: '/r/.claude/plans/x/PLAN.md' })),
    ]);

    assert.equal(episodes(text, 'plan-read-before-write').calls, 10);
    assertNone(text, 'ask-to-act-gap');
  });

  it('rejects a seven-call gap and a message that asks no change', () => {
    assertNone(
      transcript('please fix the parser', [
        splitStep(
          call('Read', { file_path: '/r/p.ts' }),
          call('Read', { file_path: '/r/q.ts' }),
        ),
        ...reads(5),
        step(edit),
      ]),
      'ask-to-act-gap',
    );
    assertNone(
      transcript('what does the parser do?', [...reads(8), step(edit)]),
      'ask-to-act-gap',
    );
  });

  it('rejects a gap that a later user message interrupts', () => {
    assertNone(
      transcript('please fix the parser', [
        ...reads(5),
        note('what does it do?'),
        ...reads(5),
        step(edit),
      ]),
      'ask-to-act-gap',
    );
  });

  it('rejects a compaction summary flagged isCompactSummary as the ask', () => {
    const text = withFirstRecordFields(
      transcript('Summary: the user asked to fix the parser.', [
        ...reads(10),
        step(edit),
      ]),
      { isCompactSummary: true },
    );

    assertNone(text, 'ask-to-act-gap');
  });

  it('rejects a continuation opener as the ask', () => {
    const text = transcript(
      'This session is being continued from a previous conversation that ran out of context. The user asked to fix the parser.',
      [...reads(10), step(edit)],
    );

    assertNone(text, 'ask-to-act-gap');
  });

  it('still matches a plain fix ask before ten reads and an edit', () => {
    const found = episodes(
      transcript('fix it', [...reads(10), step(edit)]),
      'ask-to-act-gap',
    );

    assert.equal(found.count, 1);
  });

  it('rejects a gap that a compaction boundary interrupts', () => {
    const text = transcript('fix it', [
      ...reads(5, 'before'),
      boundary(),
      ...reads(5, 'after'),
      step(edit),
    ]);

    assertNone(text, 'ask-to-act-gap');
  });
});

describe('acceptance-rerun-after-report', () => {
  const dispatch = call('Agent', { prompt: 'do it' });
  const acceptance = 'pnpm --filter @houserules/cli test';
  const report = `SLICE 1: DONE\nAcceptance\n$ ${acceptance}\n12 passed`;

  it('matches commands quoted in an Agent result and in a task notification', () => {
    const text = transcript('hi', [
      step({ ...dispatch, output: report }),
      step(call('Bash', { command: acceptance })),
      note(
        '<task-notification>ran `node scripts/verify-all.mjs` ok</task-notification>',
      ),
      step(call('Bash', { command: 'node scripts/verify-all.mjs' })),
    ]);
    const found = episodes(text, 'acceptance-rerun-after-report');
    assert.equal(found.count, 2);
    assert.equal(found.calls, 2);
    assert.equal(found.costUsd, 6);
    assert.deepEqual(found.pointers, [
      '/t/session.jsonl:4',
      '/t/session.jsonl:7',
    ]);
  });

  it('rejects a command run after a new dispatch or one the report never quoted', () => {
    assertNone(
      transcript('hi', [
        step({ ...dispatch, output: report }),
        step(dispatch),
        step(call('Bash', { command: acceptance })),
      ]),
      'acceptance-rerun-after-report',
    );
    assertNone(
      transcript('hi', [
        step({ ...dispatch, output: report }),
        step(call('Bash', { command: 'pnpm --filter @houserules/api test' })),
      ]),
      'acceptance-rerun-after-report',
    );
  });

  it('matches a compound command whose text before a grep filter sits in the report', () => {
    const compound = `cd /r && ${acceptance}`;
    const text = transcript('hi', [
      step({
        ...dispatch,
        output: `SLICE 1: DONE\nAcceptance\n$ ${compound}\n12 passed`,
      }),
      step(call('Bash', { command: `${compound} | grep -E "pass|fail"` })),
    ]);

    const found = episodes(text, 'acceptance-rerun-after-report');

    assert.equal(found.count, 1);
  });

  it('matches a command quoted in a meta hand-back message', () => {
    const text = transcript('hi', [
      metaNote(
        `Another Claude session sent a message.\n<agent-message>[Subagent hand-back]\n${report}\n</agent-message>`,
      ),
      step(call('Bash', { command: acceptance })),
    ]);

    const found = episodes(text, 'acceptance-rerun-after-report');

    assert.equal(found.count, 1);
  });

  it('matches a rerun with a different tail after a failing run that named no test', () => {
    const text = transcript('hi', [
      step(
        call(
          'Bash',
          { command: `${acceptance} | tail -5` },
          'Exit code 1\nℹ tests 3\nℹ fail 1',
        ),
      ),
      step(call('Bash', { command: `${acceptance} | tail -40` })),
    ]);

    const found = episodes(text, 'acceptance-rerun-after-report');

    assert.equal(found.count, 1);
  });

  it('rejects a rerun after a failing run that printed a FAIL line', () => {
    const text = transcript('hi', [
      step(
        call(
          'Bash',
          { command: `${acceptance} | tail -5` },
          'Exit code 1\nFAIL src/parser.test.ts > parses a header',
        ),
      ),
      step(call('Bash', { command: `${acceptance} | tail -40` })),
    ]);

    assertNone(text, 'acceptance-rerun-after-report');
  });

  it('claims a call rerun-unchanged also matches once, so kind shares sum within the total', () => {
    const failing = 'Exit code 1\nℹ tests 3\nℹ fail 1';
    const text = transcript('hi', [
      step(call('Bash', { command: `${acceptance} | tail -5` }, failing)),
      step(call('Bash', { command: `${acceptance} | tail -40` }, failing)),
      step(call('Bash', { command: `${acceptance} | tail -5` })),
    ]);

    const result = summarize([classify(text, '/t/session.jsonl')]);
    const byKind = Object.fromEntries(
      result.kinds.map((entry) => [entry.kind, entry]),
    );
    const kindCost = result.kinds.reduce(
      (total, entry) => total + entry.costUsd,
      0,
    );

    assert.equal(byKind['acceptance-rerun-after-report'].calls, 2);
    assert.equal(byKind['rerun-unchanged'].calls, 0);
    assert.equal(result.totals.costUsd, 9);
    assert.equal(kindCost, 6);
  });
});

describe('grep-after-wireit-skip', () => {
  const build = call('Bash', { command: 'pnpm build' }, '[0] Already fresh');
  const tail = call('Bash', { command: 'tail -50 /tmp/build.log' });

  it('matches a log read within the window after a skip line', () => {
    const text = transcript('hi', [
      step(build),
      step(call('Read', { file_path: '/r/a.ts' })),
      step(tail),
    ]);
    const found = episodes(text, 'grep-after-wireit-skip');
    assert.equal(found.count, 1);
    assert.equal(found.calls, 1);
    assert.deepEqual(found.pointers, ['/t/session.jsonl:6']);
  });

  it('rejects a log read past the window and one after a run that was not skipped', () => {
    assertNone(
      transcript('hi', [step(build), ...reads(3), step(tail)]),
      'grep-after-wireit-skip',
    );
    assertNone(
      transcript('hi', [
        step(call('Bash', { command: 'pnpm build' }, 'built 4 files')),
        step(tail),
      ]),
      'grep-after-wireit-skip',
    );
  });
});

describe('small-agent', () => {
  const subagentPath = '/p/sess/subagents/agent-1.jsonl';
  const calls = (count) =>
    Array.from({ length: count }, (_, i) =>
      step(call('Grep', { pattern: `p${i}` })),
    );

  it('matches a subagent transcript with four calls and prices all its requests', () => {
    const text = transcript('go', [...calls(4), textOnly()]);
    const found = episodes(text, 'small-agent', subagentPath);
    assert.equal(found.count, 1);
    assert.equal(found.calls, 4);
    assert.equal(found.costUsd, 15);
    assert.equal(found.wallSeconds, 9);
    assert.deepEqual(found.pointers, [`${subagentPath}:2`]);
  });

  it('rejects five calls and a main transcript with four', () => {
    assertNone(transcript('go', calls(5)), 'small-agent', subagentPath);
    assertNone(transcript('go', calls(4)), 'small-agent', '/p/sess.jsonl');
  });

  const handback = step(call('SubagentHandback', { message: 'done' }));

  it('leaves a terminal SubagentHandback out of the count and carries the agent type', () => {
    const text = transcript('go', [...reads(3), handback]);

    const found = classify(text, subagentPath, 'backlog-reviewer').kinds[
      'small-agent'
    ].map((episode) => ({
      calls: episode.calls,
      agentType: episode.agentType,
    }));

    assert.deepEqual(found, [{ calls: 3, agentType: 'backlog-reviewer' }]);
  });

  it('leaves a terminal StructuredOutput out of the count', () => {
    const text = transcript('go', [
      ...reads(4),
      step(call('StructuredOutput', { verdict: 'ok' })),
    ]);

    const found = episodes(text, 'small-agent', subagentPath);

    assert.equal(found.calls, 4);
  });

  it('compares the threshold against the count without the terminal handback', () => {
    const text = transcript('go', [...reads(4), handback]);

    const found = episodes(text, 'small-agent', subagentPath);

    assert.equal(found.count, 1);
    assert.equal(found.calls, 4);
  });

  it('rejects five calls before a terminal handback', () => {
    assertNone(
      transcript('go', [...reads(5), handback]),
      'small-agent',
      subagentPath,
    );
  });

  it('groups small-agent episodes by agent type, null apart, ranked by cost', () => {
    const result = summarize([
      classify(
        transcript('go', reads(1)),
        '/p/sess/subagents/agent-a.jsonl',
        'backlog-reviewer',
      ),
      classify(
        transcript('go', reads(2)),
        '/p/sess/subagents/agent-b.jsonl',
        'backlog-reviewer',
      ),
      classify(transcript('go', reads(4)), '/p/sess/subagents/agent-c.jsonl'),
    ]);

    const entry = result.kinds.find((kind) => kind.kind === 'small-agent');

    assert.deepEqual(entry.agentTypes, [
      { agentType: null, count: 1, calls: 4, wallSeconds: 8, costUsd: 12 },
      {
        agentType: 'backlog-reviewer',
        count: 2,
        calls: 3,
        wallSeconds: 6,
        costUsd: 9,
      },
    ]);
  });

  it('adds agentTypes to the small-agent entry and no other kind', () => {
    const result = summarize([
      classify(transcript('go', reads(1)), '/p/sess/subagents/agent-a.jsonl'),
    ]);

    const withAgentTypes = result.kinds
      .filter((entry) => 'agentTypes' in entry)
      .map((entry) => entry.kind);

    assert.deepEqual(withAgentTypes, ['small-agent']);
  });
});

describe('readAgentType', () => {
  const dir = mkdtempSync(join(tmpdir(), 'waste-audit-meta-'));
  let agentCounter = 0;
  const transcriptBeside = (meta) => {
    agentCounter += 1;
    const path = join(dir, `agent-${agentCounter}.jsonl`);
    writeFileSync(path, '');
    if (meta !== undefined)
      writeFileSync(join(dir, `agent-${agentCounter}.meta.json`), meta);
    return path;
  };

  it('returns the agentType of the sibling .meta.json', () => {
    const path = transcriptBeside(
      '{"agentType":"backlog-reviewer","description":"review"}',
    );

    assert.equal(readAgentType(path), 'backlog-reviewer');
  });

  for (const [name, meta] of [
    ['a missing .meta.json', undefined],
    ['an unparsable .meta.json', '{"agentType":'],
    ['a .meta.json with no agentType field', '{"description":"review"}'],
  ])
    it(`returns null for ${name}`, () => {
      const path = transcriptBeside(meta);

      assert.equal(readAgentType(path), null);
    });
});

describe('plan-read-before-write', () => {
  const planWrite = call('Write', { file_path: '/r/.claude/plans/x/PLAN.md' });
  const fire = call('Skill', { skill: 'plan-project' });

  it('matches ten reads between a Skill fire and the first plan write', () => {
    const text = transcript('plan it', [
      step(fire),
      ...reads(10),
      step(planWrite),
    ]);
    const found = episodes(text, 'plan-read-before-write');
    assert.equal(found.count, 1);
    assert.equal(found.calls, 10);
    assert.equal(found.costUsd, 30);
    assert.deepEqual(found.pointers, ['/t/session.jsonl:4']);
  });

  it('matches a typed slash command as the fire', () => {
    const text = transcript('<command-name>/plan-project</command-name>', [
      ...reads(10),
      step(planWrite),
    ]);
    const found = episodes(text, 'plan-read-before-write');
    assert.equal(found.count, 1);
    assert.deepEqual(found.pointers, ['/t/session.jsonl:2']);
  });

  it('rejects nine reads, a write outside the plans dir, and a session that never fired', () => {
    assertNone(
      transcript('plan it', [step(fire), ...reads(9), step(planWrite)]),
      'plan-read-before-write',
    );
    assertNone(
      transcript('plan it', [
        step(fire),
        ...reads(10),
        step(call('Write', { file_path: '/r/src/a.ts' })),
      ]),
      'plan-read-before-write',
    );
    assertNone(
      transcript('plan it', [...reads(10), step(planWrite)]),
      'plan-read-before-write',
    );
  });
});

describe('totals', () => {
  const records = [
    userRecord(0, 'hi'),
    assistantRecord(
      1,
      'msg_a',
      [
        {
          type: 'tool_use',
          id: 'ta1',
          name: 'Read',
          input: { file_path: '/r/x.ts' },
        },
      ],
      USAGE,
    ),
    assistantRecord(
      2,
      'msg_a',
      [
        {
          type: 'tool_use',
          id: 'ta2',
          name: 'Read',
          input: { file_path: '/r/y.ts' },
        },
      ],
      USAGE,
    ),
    userRecord(3, [
      { type: 'tool_result', tool_use_id: 'ta1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'ta2', content: 'ok' },
    ]),
    assistantRecord(
      4,
      'msg_b',
      [
        {
          type: 'tool_use',
          id: 'tb',
          name: 'Bash',
          input: { command: 'pnpm test' },
        },
      ],
      {
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
        cache_creation: {
          ephemeral_1h_input_tokens: 400_000,
          ephemeral_5m_input_tokens: 600_000,
        },
      },
    ),
    userRecord(5, [{ type: 'tool_result', tool_use_id: 'tb', content: 'ok' }]),
    assistantRecord(
      6,
      'msg_c',
      [
        {
          type: 'tool_use',
          id: 'tc',
          name: 'Bash',
          input: { command: 'pnpm test' },
        },
      ],
      { input_tokens: 500_000 },
    ),
    userRecord(9, [{ type: 'tool_result', tool_use_id: 'tc', content: 'ok' }]),
    assistantRecord(10, 'msg_d', [{ type: 'text', text: 'done' }], USAGE),
  ];
  const text =
    records.map((record) => JSON.stringify(record)).join('\n') + '\n';

  it('sums calls, wall seconds, and cost over every tool call', () => {
    const result = summarize([classify(text, '/t/multi.jsonl')]);
    assert.equal(result.sessions, 1);
    assert.deepEqual(result.totals, { calls: 4, wallSeconds: 9, costUsd: 7.2 });
    assert.deepEqual(result.unpricedModels, []);
  });

  it('attributes the rerun episode its own request only', () => {
    const rerun = episodes(text, 'rerun-unchanged', '/t/multi.jsonl');
    assert.equal(rerun.count, 1);
    assert.equal(rerun.calls, 1);
    assert.equal(rerun.wallSeconds, 4);
    assert.equal(rerun.costUsd, 1);
    assert.equal(rerun.inputTokens, 500_000);
    assert.equal(rerun.outputTokens, 0);
    assert.equal(rerun.sessionsAffected, 1);
    assert.deepEqual(rerun.pointers, ['/t/multi.jsonl:7']);
  });

  it('ranks pointers by episode cost across files and counts affected files', () => {
    const cheap = transcript('hi', [
      step(call('Bash', { command: 'pnpm test' })),
      step(call('Bash', { command: 'pnpm test' })),
    ]);
    const result = summarize([
      classify(cheap, '/t/cheap.jsonl'),
      classify(text, '/t/multi.jsonl'),
    ]);
    const rerun = result.kinds.find(
      (entry) => entry.kind === 'rerun-unchanged',
    );
    assert.equal(rerun.count, 2);
    assert.equal(rerun.sessionsAffected, 2);
    assert.deepEqual(rerun.pointers, ['/t/cheap.jsonl:4', '/t/multi.jsonl:7']);
  });

  it('starts a request wall at the api-request after the last user record, not at a late-stamped attachment', () => {
    const lateRecords = [
      userRecord(0, 'hi'),
      assistantRecord(
        1,
        'msg_1',
        [
          {
            type: 'tool_use',
            id: 'tl1',
            name: 'Read',
            input: { file_path: '/r/a.ts' },
          },
        ],
        USAGE,
      ),
      userRecord(2, [
        { type: 'tool_result', tool_use_id: 'tl1', content: 'ok' },
      ]),
      { type: 'api-request', timestamp: iso(3) },
      { type: 'attachment', timestamp: iso(60) },
      assistantRecord(
        61,
        'msg_2',
        [
          {
            type: 'tool_use',
            id: 'tl2',
            name: 'Read',
            input: { file_path: '/r/b.ts' },
          },
        ],
        USAGE,
      ),
      userRecord(62, [
        { type: 'tool_result', tool_use_id: 'tl2', content: 'ok' },
      ]),
    ];
    const lateText =
      lateRecords.map((record) => JSON.stringify(record)).join('\n') + '\n';

    const result = summarize([classify(lateText, '/t/late.jsonl')]);

    assert.equal(result.totals.wallSeconds, 61);
  });

  function resumedCallText(leadRecord) {
    const records = [
      userRecord(0, 'hi'),
      leadRecord,
      assistantRecord(
        3605,
        'msg_r',
        [
          {
            type: 'tool_use',
            id: 'tr1',
            name: 'Read',
            input: { file_path: '/r/a.ts' },
          },
        ],
        USAGE,
      ),
      userRecord(3610, [
        { type: 'tool_result', tool_use_id: 'tr1', content: 'ok' },
      ]),
    ];
    return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  }

  const resumedWall = (leadRecord) =>
    summarize([classify(resumedCallText(leadRecord), '/t/resumed.jsonl')])
      .totals.wallSeconds;

  it('starts a span at the api-request after an idle stretch, not at the user record', () => {
    const wall = resumedWall({ type: 'api-request', timestamp: iso(3600) });

    assert.equal(wall, 10);
  });

  it('starts a span at the user record when only an attachment follows it', () => {
    const wall = resumedWall({ type: 'attachment', timestamp: iso(3605) });

    assert.equal(wall, 3610);
  });

  it('starts a span at the user record when the api-request has no timestamp', () => {
    const wall = resumedWall({ type: 'api-request' });

    assert.equal(wall, 3610);
  });

  it('starts a span at the user record when the api-request timestamp does not parse', () => {
    const wall = resumedWall({ type: 'api-request', timestamp: 'not-a-time' });

    assert.equal(wall, 3610);
  });

  it('names a model with no price row and prices it at zero', () => {
    const odd = text.replaceAll(MODEL, 'claude-mystery-9');
    const result = summarize([classify(odd, '/t/odd.jsonl')]);
    assert.deepEqual(result.unpricedModels, ['claude-mystery-9']);
    assert.equal(result.totals.costUsd, 0);
  });
});

describe('cli', () => {
  it('prints waste-audit@2 with every kind, and exits 2 with no input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'waste-audit-'));
    const file = join(dir, 'session.jsonl');
    writeFileSync(
      file,
      transcript('hi', [
        step(call('Bash', { command: 'pnpm test' })),
        step(call('Bash', { command: 'pnpm test' })),
      ]),
    );
    const journal = join(dir, 'journal.jsonl');
    writeFileSync(journal, '{"not":"a transcript"}\n');
    const list = join(dir, 'sessions.txt');
    writeFileSync(
      list,
      `# comment\n${file}\t100\t2026-11-20T00:00:00Z\n${journal}\t1\tx\n`,
    );

    const run = spawnSync(process.execPath, [SCRIPT, '--sessions', list], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 0);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.schema, 'waste-audit@2');
    assert.equal(parsed.sessions, 1);
    assert.deepEqual(
      parsed.kinds.map((entry) => entry.kind),
      KIND_NAMES,
    );
    assert.equal(KIND_NAMES.length, 7);
    for (const entry of parsed.kinds) assert.ok(entry.rule.length > 0);
    assert.equal(
      parsed.kinds.find((entry) => entry.kind === 'rerun-unchanged').count,
      1,
    );

    const none = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(none.status, 2);
    assert.match(none.stderr, /Usage/);
    const onlyJournal = spawnSync(process.execPath, [SCRIPT, journal], {
      encoding: 'utf8',
    });
    assert.equal(onlyJournal.status, 2);
  });

  it('prints the agent type read beside a subagent transcript on the small-agent entry', () => {
    const subagents = join(
      mkdtempSync(join(tmpdir(), 'waste-audit-')),
      'subagents',
    );
    mkdirSync(subagents);
    const file = join(subagents, 'agent-a1.jsonl');
    writeFileSync(
      file,
      transcript('go', [
        ...reads(3),
        step(call('SubagentHandback', { message: 'done' })),
      ]),
    );
    writeFileSync(
      join(subagents, 'agent-a1.meta.json'),
      '{"agentType":"backlog-reviewer","description":"review"}',
    );

    const run = spawnSync(process.execPath, [SCRIPT, file], {
      encoding: 'utf8',
    });

    assert.equal(run.status, 0, run.stderr);
    const entry = JSON.parse(run.stdout).kinds.find(
      (kind) => kind.kind === 'small-agent',
    );
    assert.deepEqual(entry.agentTypes, [
      {
        agentType: 'backlog-reviewer',
        count: 1,
        calls: 3,
        wallSeconds: 8,
        costUsd: 12,
      },
    ]);
  });
});
