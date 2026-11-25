import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'plan-stop-rule',
);
const SKILL = join('skills', 'plan-project', 'SKILL.md');
const MILESTONE = join('skills', 'plan-project', 'references', 'milestone.md');
const ARMS = {
  'before-p1': { prompt: 'prompts/p1.txt', overlay: 'overlays/before' },
  'after-p1': { prompt: 'prompts/p1.txt', overlay: 'overlays/after' },
  'before-p2': { prompt: 'prompts/p2.txt', overlay: 'overlays/before' },
  'after-p2': { prompt: 'prompts/p2.txt', overlay: 'overlays/after' },
  'landed-p3': { prompt: 'prompts/p3.txt', overlay: 'overlays/after' },
  'fix2-p3': { prompt: 'prompts/p3.txt', overlay: 'overlays/fix2' },
  'fix3-p3': {
    prompt: 'prompts/p3.txt',
    overlay: 'overlays/fix2',
    settings: 'settings/fix3.json',
  },
};
const FIX2_ANCHOR = 'then write the files.';
const FIX2_SENTENCES = [
  'A few means at most five calls beyond the named inputs.',
  "A sweep, audit, or verification the request asks for is the plan's first phase, not grounding.",
];
const HOOK = join(FIXTURE, 'hooks', 'plan-write-reminder.mjs');
const EPISODE = join('episodes', 'health-plan.jsonl');
const REMINDER =
  'plan-project: ten calls since the skill fired and no plan file written. Write the plan files now and turn open questions into phase steps.';
const SKILL_RULE_LINES = [
  '',
  "**Grounding stops at the first write.** Read the inputs the request names and this skill's",
  'references, plus a few targeted greps, then write the files. Any fact a phase needs becomes a step',
  'in that phase, such as "confirm X", rather than a lookup now. The recorded excuses, and their',
  'answers:',
  '',
  '- "I should confirm this before cutting phases": write the phase with that check as its first step.',
  '- "`plan-lint` might reject the cut": run it after writing and fix what it reports.',
];
const SKILL_RULE_AFTER_LINE = '**persist** the result, not to replace them.';
const MILESTONE_BEFORE_LINE =
  'List each phase you expect, with its write roots. Count hub files among them: a shared test file,';
const MILESTONE_AFTER_LINES = [
  'List each phase you expect, with its write roots, from what you already know. Grounding stops at',
  'the first write, as `SKILL.md` section 2 says. Count hub files among them: a shared test file,',
];
/** sha256 of each file as recorded: overlays from the git blobs, prompts from the transcripts, except p1, which adds the headless answers, and p3, which is rewritten. */
const SHA256 = {
  'overlays/before/skills/plan-project/SKILL.md':
    '273d3f4914549369acc4c9929444a7fb983063e5aa63cb199680eea2e5771698',
  'overlays/after/skills/plan-project/SKILL.md':
    '044c5ad22e34927c0a2740f37a9c6537cbd1462dfc8334fbd10c096337a0dc81',
  'overlays/before/skills/plan-project/references/milestone.md':
    '16032c81f64aa67282f8da069c42cfc80915a0b7ae97dc4a8901f8616dbe4d0b',
  'overlays/after/skills/plan-project/references/milestone.md':
    '65e7d99aaa0e898a9da32d20b60288bfae110558b513b9acd7d0c6ec6a64826b',
  'prompts/p1.txt':
    '6fee4a636e103fa8cbb2073356d600f6eebe30792d4056e6ed5e55393f6b88ce',
  'prompts/p2.txt':
    '4c4513ce203e18d413f3b1ce4d90e5eb2a4e58e86900bd7355e627228032794b',
  'prompts/p3.txt':
    '0eb83044c3ec5b388f562dad4e5adf6dbc62486c5a3d501c69d78b987f426eef',
};
const temps = [];

const readFixture = (path) => readFileSync(join(FIXTURE, path), 'utf8');
const readLines = (path) => readFixture(path).split('\n');
const sha256 = (path) =>
  createHash('sha256')
    .update(readFileSync(join(FIXTURE, path)))
    .digest('hex');

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function twoCommitSource() {
  const source = tempDir('hr-plan-stop-rule-src-');
  git(source, ['init', '--quiet', '--initial-branch=main']);
  git(source, ['config', 'user.email', 'eval@example.invalid']);
  git(source, ['config', 'user.name', 'eval']);
  writeFileSync(join(source, 'first.txt'), 'one\n');
  git(source, ['add', '-A']);
  git(source, ['commit', '--quiet', '-m', 'first']);
  writeFileSync(join(source, 'second.txt'), 'two\n');
  git(source, ['add', '-A']);
  git(source, ['commit', '--quiet', '-m', 'second']);
  return source;
}

const makeRepo = (source, rev, dest) =>
  spawnSync(
    process.execPath,
    [
      join(FIXTURE, 'make-repo.mjs'),
      '--source',
      source,
      '--rev',
      rev,
      '--dest',
      dest,
    ],
    { encoding: 'utf8' },
  );

const jsonl = (records) =>
  records.map((record) => JSON.stringify(record)).join('\n');

function assistant(uses, parent = null) {
  return {
    type: 'assistant',
    parent_tool_use_id: parent,
    message: {
      content: uses.map(([id, name, input]) => ({
        type: 'tool_use',
        id,
        name,
        input,
      })),
    },
  };
}

function writeSample(out, arm, sample, { stream, run, tree }) {
  const dir = join(out, arm, `sample-${sample}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stream.jsonl'), jsonl(stream));
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run));
  for (const path of tree) {
    const dest = join(dir, 'tree', path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, '# ROADMAP\n');
  }
}

const episodeRecords = () => readFixture(EPISODE).trimEnd().split('\n');

/** The main thread's tool_use blocks of the recorded episode, each id once, in order. */
function episodeCalls(records) {
  const calls = [];
  for (const line of records) {
    const record = JSON.parse(line);
    if (record.type !== 'assistant') continue;
    for (const block of record.message.content)
      if (!calls.some((call) => call.id === block.id)) calls.push(block);
  }
  return calls;
}

const indexOfCall = (records, id) =>
  records.findIndex(
    (line) =>
      JSON.parse(line).type === 'assistant' && line.includes(`"id":"${id}"`),
  );

const indexOfFire = (records) =>
  records.findIndex((line) => line.includes('<command-name>/plan-project'));

/** Runs the hook on a transcript of `records` with `call` as the PostToolUse payload's call. */
function runHook(records, call) {
  const dir = tempDir('hr-plan-stop-rule-hook-');
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, `${records.join('\n')}\n`);
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      transcript_path: transcript,
      tool_use_id: call.id,
      tool_name: call.name,
      tool_input: call.input,
    }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const reminderOutput = `${JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: REMINDER,
  },
})}\n`;

describe('plan-stop-rule fixture', () => {
  after(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it('parses eval.json into one arm per side and prompt', () => {
    const spec = JSON.parse(readFixture('eval.json'));
    assert.equal(spec.validityAgent, 'plan-reviewer');
    assert.deepEqual(spec.collect, ['.claude/plans']);
    assert.ok(spec.modules.split(',').includes('plans'));
    assert.deepEqual(spec.arms, ARMS);
    for (const arm of Object.values(ARMS)) {
      assert.ok(existsSync(join(FIXTURE, arm.prompt)), arm.prompt);
      assert.ok(existsSync(join(FIXTURE, arm.overlay, SKILL)), arm.overlay);
    }
  });

  it('keeps each overlay and prompt at its recorded bytes', () => {
    for (const [path, expected] of Object.entries(SHA256))
      assert.equal(sha256(path), expected, path);
  });

  it('differs between the overlays only at the stop rule', () => {
    const before = readLines(join('overlays', 'before', SKILL));
    const at = before.indexOf(SKILL_RULE_AFTER_LINE) + 1;
    assert.ok(at > 0);
    assert.deepEqual(
      readLines(join('overlays', 'after', SKILL)),
      before.toSpliced(at, 0, ...SKILL_RULE_LINES),
    );
    const milestoneBefore = readLines(join('overlays', 'before', MILESTONE));
    const lineAt = milestoneBefore.indexOf(MILESTONE_BEFORE_LINE);
    assert.ok(lineAt > 0);
    assert.deepEqual(
      readLines(join('overlays', 'after', MILESTONE)),
      milestoneBefore.toSpliced(lineAt, 1, ...MILESTONE_AFTER_LINES),
    );
    assert.ok(!before.join('\n').includes('Grounding stops'));
  });

  it('pairs each prompt across the sides as one /plan-project call', () => {
    for (const prompt of ['prompts/p1.txt', 'prompts/p2.txt']) {
      const sides = Object.values(ARMS).filter((arm) => arm.prompt === prompt);
      assert.deepEqual(sides.map((arm) => arm.overlay).sort(), [
        'overlays/after',
        'overlays/before',
      ]);
      const text = readFixture(prompt);
      assert.ok(text.startsWith('/plan-project '), prompt);
      assert.ok(!text.endsWith('\n'), prompt);
    }
    assert.ok(readFixture('prompts/p1.txt').includes('`ignored-payload`'));
    assert.ok(
      existsSync(
        join(
          FIXTURE,
          'seed',
          '.claude',
          'plans',
          'ignored-payload',
          'ROADMAP.md',
        ),
      ),
    );
  });

  it('runs the rewritten p3 request against the landed, fix 2, and fix 3 arms', () => {
    const sides = Object.entries(ARMS)
      .filter(([, arm]) => arm.prompt === 'prompts/p3.txt')
      .map(([name]) => name);
    const text = readFixture('prompts/p3.txt');

    assert.deepEqual(sides, ['landed-p3', 'fix2-p3', 'fix3-p3']);
    assert.ok(text.startsWith('/plan-project '), text.slice(0, 40));
    assert.ok(!text.endsWith('\n'), 'p3 ends without a newline');
    for (const note of [
      '.notes/houserules-usage-2026-11-19.md',
      '.notes/work-colleague-houserules-usage-2026-11-19.md',
      '.notes/work-houserules-usage-2026-11-19.md',
    ])
      assert.ok(text.includes(note), note);
    assert.ok(text.includes('ops/handoff/ridge.txt'), 'trail start');
    assert.ok(text.includes('sign-off token'), 'trail end');
    assert.ok(!text.includes('open issues'), 'no gh issue list dependency');
  });

  it('seeds a ten-page handoff trail that ends at the sign-off token', () => {
    let path = 'ops/handoff/ridge.txt';
    const visited = [];

    while (path) {
      visited.push(path);
      const text = readFixture(join('seed', path));
      const [, next] =
        text.match(/\b((?:ops|packages|scripts)\/[\w/.-]+\.txt)/) ?? [];
      path = next;
      if (!next) assert.ok(text.includes('MARLIN-4471'), visited.at(-1));
    }

    assert.equal(visited.length, 10);
  });

  it('differs from the after overlay by exactly the two fix 2 sentences', () => {
    const after = readFixture(join('overlays', 'after', SKILL));
    const anchorAt = after.indexOf(FIX2_ANCHOR) + FIX2_ANCHOR.length;
    const collapse = (text) => text.replace(/\s+/g, ' ');

    const fix2 = readFixture(join('overlays', 'fix2', SKILL));

    assert.equal(
      collapse(fix2),
      collapse(
        `${after.slice(0, anchorAt)} ${FIX2_SENTENCES.join(' ')}${after.slice(anchorAt)}`,
      ),
    );
    const afterLines = after.split('\n');
    const fix2Lines = fix2.split('\n');
    const ruleAt = afterLines.findIndex((line) =>
      line.startsWith('**Grounding stops at the first write.**'),
    );
    assert.deepEqual(fix2Lines.slice(0, ruleAt), afterLines.slice(0, ruleAt));
    assert.deepEqual(
      fix2Lines.slice(fix2Lines.length - (afterLines.length - ruleAt - 4)),
      afterLines.slice(ruleAt + 4),
      'only the four-line stop-rule paragraph rewraps',
    );
    assert.equal(
      readFixture(join('overlays', 'fix2', MILESTONE)),
      readFixture(join('overlays', 'after', MILESTONE)),
    );
  });

  it('wires the fix 3 settings to a PostToolUse hook that exists', () => {
    const settings = JSON.parse(
      readFixture('settings/fix3.json').replaceAll('{{fixtureDir}}', FIXTURE),
    );

    const [entry] = settings.hooks.PostToolUse;
    const [command] = entry.hooks;

    assert.deepEqual(Object.keys(settings), ['hooks']);
    assert.equal(command.type, 'command');
    assert.equal(command.command, `node "${HOOK}"`);
    assert.ok(existsSync(HOOK), HOOK);
  });

  it('reminds at the tenth non-writing call after the fire and at no other', () => {
    const records = episodeRecords();
    const calls = episodeCalls(records);
    const fired = [];

    for (const [index, call] of calls.slice(0, 21).entries()) {
      const through = records.slice(0, indexOfCall(records, call.id) + 1);
      if (runHook(through, call) !== '') fired.push(index);
    }

    assert.equal(calls[0].input.command.startsWith('wc -c .notes'), true);
    assert.ok(indexOfCall(records, calls[0].id) < indexOfFire(records));
    assert.deepEqual(
      fired,
      [10],
      'call 0 precedes the fire, calls 1 to 20 follow it',
    );
  });

  it('prints the one-line reminder for the tenth call', () => {
    const records = episodeRecords();
    const tenth = episodeCalls(records)[10];

    const output = runHook(
      records.slice(0, indexOfCall(records, tenth.id) + 1),
      tenth,
    );

    assert.equal(output, reminderOutput);
  });

  it('counts the payload call when the transcript does not hold it yet', () => {
    const records = episodeRecords();
    const calls = episodeCalls(records);

    const output = runHook(
      records.slice(0, indexOfCall(records, calls[10].id)),
      calls[10],
    );

    assert.equal(output, reminderOutput);
  });

  it('ignores calls the transcript holds after the payload call', () => {
    const records = episodeRecords();
    const calls = episodeCalls(records);

    const outputs = [9, 10, 11].map((index) => runHook(records, calls[index]));

    assert.deepEqual(outputs, ['', reminderOutput, '']);
  });

  it('stays silent on the tenth call after a plan write', () => {
    const records = episodeRecords();
    const calls = episodeCalls(records);
    const write = calls[21];
    const afterWrite = calls[22];
    const ninth = indexOfCall(records, calls[9].id);
    const withoutWrite = [
      ...records.slice(0, ninth + 1),
      records[indexOfCall(records, afterWrite.id)],
    ];
    const withWrite = [
      ...records.slice(0, ninth + 1),
      records[indexOfCall(records, write.id)],
      records[indexOfCall(records, afterWrite.id)],
    ];

    const outputs = [withoutWrite, withWrite].map((transcript) =>
      runHook(transcript, afterWrite),
    );

    assert.equal(write.name, 'Write');
    assert.ok(
      write.input.file_path.includes('.claude/plans/'),
      write.input.file_path,
    );
    assert.deepEqual(outputs, [reminderOutput, '']);
  });

  it('stays silent when plan-project never fired', () => {
    const records = episodeRecords();
    const calls = episodeCalls(records);
    const unfired = records.toSpliced(indexOfFire(records), 1);

    const output = runHook(unfired, calls[11]);

    assert.equal(output, '');
  });

  it('fires on a plan-project Skill call as well as the slash command', () => {
    const records = episodeRecords();
    const calls = episodeCalls(records);
    const skill = JSON.stringify(
      assistant([['skill-1', 'Skill', { skill: 'houserules:plan-project' }]]),
    );
    const viaSkill = records.toSpliced(indexOfFire(records), 1, skill);

    const output = runHook(
      viaSkill.slice(0, indexOfCall(viaSkill, calls[10].id) + 1),
      calls[10],
    );

    assert.equal(output, reminderOutput);
  });

  it('exits 0 and prints nothing on a missing transcript or a bad payload', () => {
    const missing = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ transcript_path: '/nonexistent/t.jsonl' }),
      encoding: 'utf8',
    });
    const garbage = spawnSync(process.execPath, [HOOK], {
      input: 'not json',
      encoding: 'utf8',
    });

    assert.deepEqual(
      [missing.status, missing.stdout, garbage.status, garbage.stdout],
      [0, '', 0, ''],
    );
  });

  it('scores calls before the first plan write, wall, cost, and a new roadmap', () => {
    const out = tempDir('hr-plan-stop-rule-score-');
    const overlays = [
      { path: 'x', initSha256: 'a', overlaySha256: 'b', exitSha256: 'b' },
    ];
    const run = { validityAgent: 'plan-reviewer', overlays };
    writeSample(out, 'before-p1', 1, {
      run,
      tree: [
        '.claude/plans/ignored-payload/ROADMAP.md',
        '.claude/plans/standards/efficiency/ROADMAP.md',
      ],
      stream: [
        assistant([
          [
            't1',
            'Read',
            { file_path: '/r/.claude/plans/ignored-payload/PLAN.md' },
          ],
          [
            't2',
            'Bash',
            { command: 'ls .claude/plans/ 2>/dev/null; cat a 2>&1' },
          ],
        ]),
        assistant([['t2', 'Bash', { command: 'ls .claude/plans/' }]]),
        assistant(
          [['s1', 'Write', { file_path: '/r/.claude/plans/sub.md' }]],
          'agent-1',
        ),
        assistant([['t3', 'Bash', { command: 'cp .claude/plans/a /tmp/b' }]]),
        assistant([
          [
            't4',
            'Bash',
            {
              command:
                'git log | grep x && cat > .claude/plans/standards/MILESTONE.md <<EOF\nx\nEOF',
            },
          ],
        ]),
        assistant([
          [
            't5',
            'Write',
            { file_path: '/r/.claude/plans/standards/efficiency/ROADMAP.md' },
          ],
          ['t6', 'Agent', { subagent_type: 'plan-reviewer' }],
        ]),
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 61_500,
          total_cost_usd: 7.25,
          subagent_stats: { by_type: { 'plan-reviewer': 1 } },
        },
      ],
    });
    writeSample(out, 'after-p1', 1, {
      run,
      tree: ['.claude/plans/ignored-payload/ROADMAP.md'],
      stream: [
        assistant([
          [
            'u1',
            'Bash',
            { command: 'node .claude/scripts/plan-scaffold.mjs standards' },
          ],
          ['u2', 'Read', { file_path: '/r/README.md' }],
        ]),
        { type: 'result', subtype: 'error_max_budget_usd', is_error: true },
      ],
    });
    writeFileSync(
      join(out, 'spend.jsonl'),
      `${JSON.stringify({ arm: 'after-p1', sample: 1, sessionId: null, costUsd: 9.5 })}\n`,
    );
    writeSample(out, 'after-p2', 1, {
      run,
      tree: [],
      stream: [assistant([['v1', 'Grep', { pattern: 'x' }]])],
    });

    const scored = spawnSync(
      process.execPath,
      [join(FIXTURE, 'score.mjs'), out],
      { encoding: 'utf8' },
    );
    assert.equal(scored.status, 0, scored.stderr);
    const rows = scored.stdout
      .trimEnd()
      .split('\n')
      .filter((line) => !line.startsWith('JSON '));
    assert.deepEqual(rows, [
      'arm\tsample\tvalid\tbeforeWrite\tcalls\twallS\tcost\troadmap',
      'after-p1\t1\tfalse\t0\t2\t-\t9.5000\tfalse',
      'after-p2\t1\tfalse\t-\t1\t-\t-\tfalse',
      'before-p1\t1\ttrue\t3\t6\t61.5\t7.2500\ttrue',
    ]);
  });

  it('reads a heredoc into a shell-variable path under .claude/plans as the first plan write', () => {
    const out = tempDir('hr-plan-stop-rule-variable-');
    writeSample(out, 'after-p2', 1, {
      run: { validityAgent: 'plan-reviewer', overlays: [] },
      tree: ['.claude/plans/health/ROADMAP.md'],
      stream: [
        assistant([
          ['w1', 'Bash', { command: 'ls .claude/plans' }],
          [
            'w2',
            'Bash',
            {
              command:
                "W=.claude/plans/health; mkdir -p $W/baseline\ncat > ${W}/PLAN.md <<'EOF'\nx\nEOF",
            },
          ],
        ]),
      ],
    });

    const scored = spawnSync(
      process.execPath,
      [join(FIXTURE, 'score.mjs'), out],
      { encoding: 'utf8' },
    );

    assert.equal(scored.status, 0, scored.stderr);
    const row = scored.stdout
      .split('\n')
      .find((line) => line.startsWith('after-p2'));
    assert.equal(row.split('\t')[3], '1', row);
  });

  it('builds the repo from one rev of a source and overlays the seed', () => {
    const source = twoCommitSource();
    const dest = join(tempDir('hr-plan-stop-rule-dest-'), 'repo');

    const built = makeRepo(source, 'HEAD~1', dest);

    assert.equal(built.status, 0, built.stderr);
    assert.equal(readFileSync(join(dest, 'first.txt'), 'utf8'), 'one\n');
    assert.ok(!existsSync(join(dest, 'second.txt')));
    const seedPlan = join('.claude', 'plans', 'ignored-payload');
    assert.deepEqual(
      readdirSync(join(dest, seedPlan)).sort(),
      readdirSync(join(FIXTURE, 'seed', seedPlan)).sort(),
    );
    assert.equal(
      readFileSync(join(dest, seedPlan, 'PLAN.md'), 'utf8'),
      readFixture(join('seed', seedPlan, 'PLAN.md')),
    );
  });

  it('refuses an existing dest and leaves its files in place', () => {
    const source = twoCommitSource();
    const dest = tempDir('hr-plan-stop-rule-dest-');
    writeFileSync(join(dest, 'kept.txt'), 'kept\n');

    const refused = makeRepo(source, 'HEAD', dest);

    assert.equal(refused.status, 2, refused.stderr);
    assert.deepEqual(readdirSync(dest), ['kept.txt']);
  });
});
