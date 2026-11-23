import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../health-kit/gather/agent-ledger.mjs', import.meta.url),
);

const MODEL = 'claude-sonnet-5-5-20261001';
const USAGE = { input_tokens: 10, output_tokens: 5 };
/** Fixture turns are stamped one second apart from this instant. */
const FIXTURE_START_MS = Date.parse('2026-11-20T00:00:00Z');
let counter = 0;

const turn = (perTurnEffort, blocks = [{ type: 'text', text: 'ok' }]) => {
  counter += 1;
  const record = {
    type: 'assistant',
    timestamp: new Date(FIXTURE_START_MS + counter * 1000).toISOString(),
    message: {
      id: `msg_${counter}`,
      model: MODEL,
      role: 'assistant',
      content: blocks,
      usage: USAGE,
    },
  };
  if (perTurnEffort !== undefined) record.perTurnEffort = perTurnEffort;
  return record;
};

const jsonl = (records) =>
  records.map((record) => JSON.stringify(record)).join('\n') + '\n';

/** Runs the script over a one-session fixture and returns rows keyed by kind and agent type. */
function run({ mainTurns, subagents = [] }) {
  const base = mkdtempSync(join(tmpdir(), 'agent-ledger-test-'));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const config = join(base, 'config');
  const slug = join(config, 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'));
  const session = '11111111-2222-3333-4444-555555555555';
  mkdirSync(join(slug, session, 'subagents'), { recursive: true });
  writeFileSync(join(slug, `${session}.jsonl`), jsonl(mainTurns));
  for (const [index, fixture] of subagents.entries()) {
    const name = `agent-aaaaaaa${index}`;
    const dir = join(slug, session, 'subagents');
    writeFileSync(join(dir, `${name}.jsonl`), jsonl(fixture.turns));
    writeFileSync(
      join(dir, `${name}.meta.json`),
      JSON.stringify({
        agentType: fixture.agentType,
        spawnDepth: 1,
        toolUseId: fixture.toolUseId,
      }),
    );
  }
  const out = join(base, 'ledger.json');
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--machine', 'local', '--out', out, repo],
    { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config } },
  );
  assert.equal(result.status, 0, result.stderr);
  const { rows } = JSON.parse(readFileSync(out, 'utf8'));
  return {
    main: rows.find((row) => row.kind === 'main'),
    subagent: (type) => rows.find((row) => row.agentType === type),
  };
}

const spawn = (id, input) => ({
  type: 'tool_use',
  id,
  name: 'Agent',
  input: { prompt: 'x', ...input },
});

describe('agent-ledger effort', () => {
  it('takes a main row effort from the recorded turns', () => {
    const { main } = run({ mainTurns: [turn('high'), turn('high')] });
    assert.equal(main.effort, 'high');
  });

  it('leaves a main row with no recorded effort null', () => {
    const { main } = run({ mainTurns: [turn(undefined), turn(undefined)] });
    assert.equal(main.effort, null);
  });

  it('ignores a recorded value outside the effort keywords', () => {
    const { main } = run({ mainTurns: [turn('turbo'), turn('low')] });
    assert.equal(main.effort, 'low');
  });

  it('takes the effort most turns carry, a tie going to the later turn', () => {
    const majority = run({
      mainTurns: [
        turn('low'),
        turn('high'),
        turn('high'),
        turn('low'),
        turn('high'),
      ],
    });
    assert.equal(majority.main.effort, 'high');
    const tie = run({ mainTurns: [turn('high'), turn('low')] });
    assert.equal(tie.main.effort, 'low');
  });

  it('keeps a pinned subagent effort from the spawning call', () => {
    const { subagent } = run({
      mainTurns: [turn('medium', [spawn('tu_1', { effort: 'xhigh' })])],
      subagents: [
        { agentType: 'pinned', toolUseId: 'tu_1', turns: [turn('low')] },
      ],
    });
    assert.equal(subagent('pinned').effort, 'xhigh');
  });

  it('leaves an unpinned subagent null even when its transcript records effort', () => {
    const { subagent } = run({
      mainTurns: [turn('medium', [spawn('tu_2', {})])],
      subagents: [
        {
          agentType: 'general-purpose',
          toolUseId: 'tu_2',
          turns: [turn('high')],
        },
      ],
    });
    assert.equal(subagent('general-purpose').effort, null);
  });
});
