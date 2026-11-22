import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { childArgv, childEnv, runSession } from '../child.mjs';
import { NO_SLUG_PROMPT, SAMPLE_MODEL, SAMPLE_PROMPT } from '../layout.mjs';
import { writeStubClaude } from './stub-claude.mjs';

const PER_RUN = 7.5;

function scratch() {
  return mkdtempSync(join(tmpdir(), 'hr-eval-child-'));
}

const RECORDING_STUB = `
import { appendFileSync, readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const out = process.env.EVAL_STUB_RECORD;
let stdin = '';
try { stdin = readFileSync(0, 'utf8'); } catch {}
appendFileSync(out, JSON.stringify({
  prompt: argv[argv.indexOf('-p') + 1],
  envKeys: Object.keys(process.env),
  stdin,
  argv,
}));
console.log(JSON.stringify({ type: 'result', session_id: 'none', total_cost_usd: 0 }));
`;

async function runRecording(prompt) {
  const dir = scratch();
  const stub = writeStubClaude(RECORDING_STUB);
  const recordPath = join(dir, 'record.json');
  const argv = childArgv({ prompt, model: SAMPLE_MODEL, perRun: PER_RUN });
  await runSession({
    cwd: dir,
    outDir: join(dir, 'out'),
    argv,
    env: childEnv({
      PATH: stub.path,
      EVAL_STUB_RECORD: recordPath,
      CLAUDE_X: '1',
      CLAUDECODE: '1',
    }),
    timeoutMinutes: 1,
    home: dir,
  });
  return JSON.parse(readFileSync(recordPath, 'utf8'));
}

describe('child invocation', () => {
  it('sends SAMPLE_PROMPT right after -p and the specified flags', async () => {
    const record = await runRecording(SAMPLE_PROMPT);
    assert.equal(record.prompt, SAMPLE_PROMPT);
    assert.ok(
      record.argv.join(' ').includes('--setting-sources project,local'),
    );
    assert.equal(
      record.argv[record.argv.indexOf('--max-budget-usd') + 1],
      String(PER_RUN),
    );
    assert.ok(!record.argv.includes('--tools'));
  });

  it('builds the no-slug argv with /orchestrate --auto', () => {
    const argv = childArgv({
      prompt: NO_SLUG_PROMPT,
      model: SAMPLE_MODEL,
      perRun: PER_RUN,
    });
    assert.equal(argv[argv.indexOf('-p') + 1], '/orchestrate --auto');
  });

  it('adds --tools only when given, including the empty string', () => {
    const argv = childArgv({
      prompt: 'x',
      model: SAMPLE_MODEL,
      perRun: 1,
      tools: '',
    });
    assert.equal(argv[argv.indexOf('--tools') + 1], '');
  });

  it('removes every CLAUDE variable and gives the child an empty stdin', async () => {
    const record = await runRecording(SAMPLE_PROMPT);
    assert.deepEqual(
      record.envKeys.filter((name) => name.startsWith('CLAUDE')),
      [],
    );
    assert.ok(record.envKeys.includes('EVAL_STUB_RECORD'));
    assert.equal(record.stdin, '');
  });

  it('copies the transcript file and directory and returns the result event', async () => {
    const dir = scratch();
    const home = join(dir, 'home');
    const stub = writeStubClaude(`
import { mkdirSync, writeFileSync } from 'node:fs';
const sid = 'sid-123';
const base = process.env.HOME + '/.claude/projects/some-slug';
mkdirSync(base + '/' + sid + '/subagents', { recursive: true });
writeFileSync(base + '/' + sid + '.jsonl', '{}\\n');
writeFileSync(base + '/' + sid + '/subagents/agent-x.jsonl', '{}\\n');
console.log(JSON.stringify({ type: 'system', session_id: sid }));
console.log('not json');
console.log(JSON.stringify({ type: 'result', session_id: sid, total_cost_usd: 1.25 }));
`);
    const outDir = join(dir, 'out');
    const result = await runSession({
      cwd: dir,
      outDir,
      argv: childArgv({
        prompt: SAMPLE_PROMPT,
        model: SAMPLE_MODEL,
        perRun: PER_RUN,
      }),
      env: { PATH: stub.path, HOME: home },
      timeoutMinutes: 1,
      home,
    });
    assert.equal(result.sessionId, 'sid-123');
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.resultEvent.total_cost_usd, 1.25);
    assert.ok(existsSync(join(outDir, 'transcripts', 'sid-123.jsonl')));
    assert.ok(
      existsSync(
        join(outDir, 'transcripts', 'sid-123', 'subagents', 'agent-x.jsonl'),
      ),
    );
    assert.ok(existsSync(join(outDir, 'stream.jsonl')));
    assert.ok(existsSync(join(outDir, 'stderr.txt')));
  });

  it('kills the whole process group at the timeout', async () => {
    const dir = scratch();
    const pidFile = join(dir, 'grandchild.pid');
    const stub = writeStubClaude(`
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const grandchild = spawn('sleep', ['60'], { stdio: 'ignore' });
writeFileSync(process.env.EVAL_STUB_PIDFILE, String(process.pid) + '\\n');
setTimeout(() => {}, 60000);
`);
    const result = await runSession({
      cwd: dir,
      outDir: join(dir, 'out'),
      argv: childArgv({
        prompt: SAMPLE_PROMPT,
        model: SAMPLE_MODEL,
        perRun: PER_RUN,
      }),
      env: { PATH: stub.path, EVAL_STUB_PIDFILE: pidFile },
      timeoutMinutes: 0.05,
      home: dir,
    });
    assert.equal(result.timedOut, true);
    const groupLeader = Number(readFileSync(pidFile, 'utf8').trim());
    assert.throws(() => process.kill(-groupLeader, 0), { code: 'ESRCH' });
  });
});
