// Cases for one eval slice. `scripts/__tests__/eval.test.mjs` imports this file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CLAIM_IDS, LEDGER, RUN_JSON, VERDICT } from '../layout.mjs';
import { writeStubClaude } from './stub-claude.mjs';

const RUN_SCRIPT = new URL('../run.mjs', import.meta.url).pathname;
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_NOT_STARTED = 2;
const API_KEY = 'sk-eval-test-key-5521';

/**
 * A stub `claude` that appends each invocation to `$EVAL_STUB_DIR/calls`, records each session's
 * argv and auth environment beside it, and prints a stream shaped by its prompt.
 */
const STUB = writeStubClaude(`
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const record = process.env.EVAL_STUB_DIR;
appendFileSync(join(record, 'calls'), argv.join(' ') + '\\n');
if (argv[0] === '--version') {
  console.log('9.9.9 (Claude Code)');
  process.exit(0);
}
const sessionId = randomUUID();
const prompt = argv[argv.indexOf('-p') + 1];
writeFileSync(join(record, 'session-' + sessionId + '.json'), JSON.stringify({
  prompt,
  argv,
  apiKey: process.env.ANTHROPIC_API_KEY ?? null,
  hasAuthToken: 'ANTHROPIC_AUTH_TOKEN' in process.env,
}));
const emit = (event) => console.log(JSON.stringify({ session_id: sessionId, ...event }));
emit({ type: 'system', subtype: 'init', apiKeySource: process.env.EVAL_STUB_KEY_SOURCE ?? 'ANTHROPIC_API_KEY' });
const projects = join(process.env.HOME, '.claude', 'projects', 'stub');
mkdirSync(projects, { recursive: true });
let result;
if (prompt.startsWith('The repo CLAUDE.md')) {
  result = { subtype: 'success', is_error: false, result: 'HR-EVAL-TOKEN-4417', total_cost_usd: 0.001 };
} else if (prompt.startsWith('Your first action')) {
  const usage = { input_tokens: 0, output_tokens: 4000 };
  writeFileSync(join(projects, sessionId + '.jsonl'),
    JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-haiku-4-5', usage } }) + '\\n');
  result = { subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.022 };
} else {
  writeFileSync(join(projects, sessionId + '.jsonl'), '{}\\n');
  result = {
    subtype: 'success',
    is_error: false,
    result: 'done',
    total_cost_usd: 0.5,
    subagent_stats: { by_type: { 'phase-orchestrator': 1 } },
  };
}
emit({ type: 'result', ...result });
`);

function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), `hr-eval-run-${prefix}-`));
}

/** A node script that writes what `init --yes --modules plans,orchestrate` writes, and logs its call. */
function writeStubCli(dir, recordDir) {
  const path = join(dir, 'stub-cli.mjs');
  writeFileSync(
    path,
    `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(recordDir, 'cli-calls'))}, argv.join(' ') + '\\n');
if (argv.join(' ') !== 'init --yes --modules plans,orchestrate') process.exit(3);
mkdirSync('.claude/plans', { recursive: true });
mkdirSync('.claude/scripts', { recursive: true });
writeFileSync('.claude/plans/.gitignore', '*\\n!.gitignore\\n');
writeFileSync('.claude/scripts/plan-lint.mjs', 'process.exit(0);\\n');
writeFileSync('.claude/houserules.manifest.json', JSON.stringify({ files: { '.claude/scripts/plan-lint.mjs': {} } }));
appendFileSync('CLAUDE.md', '\\nstub install section\\n');
`,
  );
  return path;
}

function writeKeyFile(dir, content, mode) {
  const path = join(dir, 'api-key');
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

/** A fresh setup: work and out paths, a record dir the stubs log to, a home, and a stub CLI. */
function setup() {
  const base = scratch('case');
  const recordDir = scratch('record');
  return {
    base,
    recordDir,
    work: join(base, 'work'),
    out: join(base, 'out'),
    home: scratch('home'),
    cliPath: writeStubCli(base, recordDir),
    keyFile: writeKeyFile(base, `  ${API_KEY}\n`, 0o600),
  };
}

function runEval(context, args, extraEnv = {}) {
  const env = {
    ...process.env,
    PATH: STUB.path,
    HOME: context.home,
    HOUSERULES_EVAL_CLI: context.cliPath,
    EVAL_STUB_DIR: context.recordDir,
    ANTHROPIC_AUTH_TOKEN: 'auth-token-the-child-must-not-see',
    ...extraEnv,
  };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [RUN_SCRIPT, ...args], {
    encoding: 'utf8',
    env,
  });
}

function ledgerLines(out) {
  const path = join(out, LEDGER);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function stubSessions(recordDir) {
  return readdirSync(recordDir)
    .filter((name) => name.startsWith('session-'))
    .map((name) => JSON.parse(readFileSync(join(recordDir, name), 'utf8')));
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function paidArgs(context, extra) {
  return [
    '--paid',
    '--api-key-file',
    context.keyFile,
    '--work',
    context.work,
    '--out',
    context.out,
    ...extra,
  ];
}

describe('run refusals', () => {
  const cases = [
    {
      name: '--paid without --margin',
      error: /requires finite non-negative values for: margin/,
      args: (context) => [
        '--paid',
        '--api-key-file',
        context.keyFile,
        '--budget',
        '10',
        '--per-run',
        '1',
        '--samples',
        '1',
        '--work',
        context.work,
        '--out',
        context.out,
      ],
    },
    {
      name: 'a scratchpad --work',
      error: /"scratchpad" segment/,
      args: (context) => [
        ...paidArgs(context, ['--budget', '10', '--per-run', '1']),
        '--margin',
        '0',
        '--samples',
        '1',
        '--work',
        join(context.base, 'scratchpad', 'work'),
      ],
    },
    {
      name: '--preflight with a --per-run other than the probe cap',
      error: /--preflight requires --per-run 0\.02/,
      args: (context) =>
        paidArgs(context, [
          '--preflight',
          '--budget',
          '10',
          '--per-run',
          '3',
          '--margin',
          '1',
        ]),
    },
    {
      name: 'a scratchpad --work on the free default',
      error: /"scratchpad" segment/,
      args: (context) => ['--work', join(context.base, 'scratchpad', 'w')],
    },
    {
      name: '--paid without --api-key-file',
      error: /--paid requires --api-key-file/,
      args: (context) => [
        '--paid',
        '--budget',
        '10',
        '--per-run',
        '1',
        '--margin',
        '0',
        '--samples',
        '1',
        '--work',
        context.work,
        '--out',
        context.out,
      ],
    },
    {
      name: 'a missing key file',
      error: /no-such-key does not exist/,
      args: (context) => [
        ...paidArgs(context, ['--budget', '10', '--per-run', '1']),
        '--margin',
        '0',
        '--samples',
        '1',
        '--api-key-file',
        join(context.base, 'no-such-key'),
      ],
    },
    {
      name: 'an empty key file',
      error: /api-key is empty/,
      args: (context) => [
        ...paidArgs(context, ['--budget', '10', '--per-run', '1']),
        '--margin',
        '0',
        '--samples',
        '1',
        '--api-key-file',
        writeKeyFile(scratch('key'), '  \n', 0o600),
      ],
    },
    {
      name: 'a group-readable key file',
      error: /has mode 640/,
      args: (context) => [
        ...paidArgs(context, ['--budget', '10', '--per-run', '1']),
        '--margin',
        '0',
        '--samples',
        '1',
        '--api-key-file',
        writeKeyFile(scratch('key'), API_KEY, 0o640),
      ],
    },
    {
      name: 'an other-readable key file',
      error: /has mode 604/,
      args: (context) => [
        ...paidArgs(context, ['--budget', '10', '--per-run', '1']),
        '--margin',
        '0',
        '--samples',
        '1',
        '--api-key-file',
        writeKeyFile(scratch('key'), API_KEY, 0o604),
      ],
    },
  ];

  for (const refusal of cases) {
    it(`refuses ${refusal.name} before any build or session`, () => {
      const context = setup();
      const result = runEval(context, refusal.args(context));
      assert.equal(result.status, EXIT_NOT_STARTED, result.stdout);
      assert.match(result.stderr, refusal.error);
      assert.equal(existsSync(join(context.recordDir, 'calls')), false);
      assert.equal(existsSync(join(context.recordDir, 'cli-calls')), false);
      assert.equal(existsSync(join(context.out, LEDGER)), false);
      assert.equal(result.stderr.includes(API_KEY), false);
    });
  }
});

describe('run free default', () => {
  it('assembles sample-1, prints the child command, and writes nothing under --out', () => {
    const context = setup();
    const result = runEval(context, [
      '--work',
      context.work,
      '--out',
      context.out,
    ]);
    assert.equal(result.status, EXIT_OK, result.stderr);
    const lines = result.stdout.split('\n');
    assert.ok(
      lines.some((line) =>
        line.startsWith(
          'claude -p "/orchestrate eval-fixture 1 --auto" --model claude-opus-5-5 ',
        ),
      ),
      result.stdout,
    );
    assert.equal(existsSync(context.out), false);
    assert.equal(existsSync(join(context.recordDir, 'calls')), false);
  });
});

describe('run paid samples', () => {
  const context = setup();
  const result = runEval(
    context,
    paidArgs(context, [
      '--samples',
      '2',
      '--budget',
      '10',
      '--per-run',
      '1',
      '--margin',
      '0',
    ]),
  );

  it('exits by the verdict and writes it with the five claim keys', () => {
    const written = JSON.parse(
      readFileSync(join(context.out, VERDICT), 'utf8'),
    );
    assert.deepEqual(Object.keys(written.claims), [...CLAIM_IDS]);
    assert.equal(result.status, written.exitCode, result.stderr);
    for (const id of CLAIM_IDS) {
      assert.ok(
        result.stdout.split('\n').includes(`${id} ${written.claims[id]}`),
      );
    }
  });

  it('writes two run.json files and two ledger lines', () => {
    for (const sample of [1, 2]) {
      const run = JSON.parse(
        readFileSync(join(context.out, `sample-${sample}`, RUN_JSON), 'utf8'),
      );
      assert.equal(run.sample, sample);
      assert.equal(run.apiKeySource, 'ANTHROPIC_API_KEY');
      assert.equal(run.claudeVersion, '9.9.9 (Claude Code)');
      assert.equal(run.prompt, '/orchestrate eval-fixture 1 --auto');
      assert.equal(run.leftTree.hasDecoyJs, false);
    }
    assert.deepEqual(
      ledgerLines(context.out).map((line) => [line.sample, line.costUsd]),
      [
        [1, 0.5],
        [2, 0.5],
      ],
    );
  });

  it('hands the child the trimmed key and drops ANTHROPIC_AUTH_TOKEN', () => {
    const sessions = stubSessions(context.recordDir);
    assert.equal(sessions.length, 2);
    for (const session of sessions) {
      assert.equal(session.apiKey, API_KEY);
      assert.equal(session.hasAuthToken, false);
      assert.equal(
        session.argv[session.argv.indexOf('--model') + 1],
        'claude-opus-5-5',
      );
      assert.equal(
        session.argv[session.argv.indexOf('--max-budget-usd') + 1],
        '1',
      );
    }
  });

  it('writes the key into no file under --out or --work', () => {
    const files = [...filesUnder(context.out), ...filesUnder(context.work)];
    assert.ok(files.length > 0);
    for (const file of files) {
      assert.equal(
        readFileSync(file).includes(API_KEY),
        false,
        `${file} holds the key`,
      );
    }
    assert.equal(result.stdout.includes(API_KEY), false);
    assert.equal(result.stderr.includes(API_KEY), false);
  });

  it('starts no session on a rerun when both samples are valid', () => {
    const rerun = runEval(
      context,
      paidArgs(context, [
        '--samples',
        '2',
        '--budget',
        '10',
        '--per-run',
        '1',
        '--margin',
        '0',
      ]),
    );
    assert.equal(rerun.status, EXIT_FAILED, rerun.stderr);
    assert.equal(ledgerLines(context.out).length, 2);
    assert.equal(stubSessions(context.recordDir).length, 2);
  });

  it('judges again under --verdict-only without touching the ledger', () => {
    const before = readFileSync(join(context.out, LEDGER), 'utf8');
    const judged = runEval(context, ['--verdict-only', '--out', context.out]);
    const written = JSON.parse(
      readFileSync(join(context.out, VERDICT), 'utf8'),
    );
    assert.equal(judged.status, written.exitCode, judged.stderr);
    assert.equal(readFileSync(join(context.out, LEDGER), 'utf8'), before);
  });

  it('refuses --verdict-only with --work', () => {
    const judged = runEval(context, [
      '--verdict-only',
      '--out',
      context.out,
      '--work',
      context.work,
    ]);
    assert.equal(judged.status, EXIT_NOT_STARTED);
  });
});

describe('run paid no-slug session', () => {
  it('runs the no-slug prompt once and never retries it', () => {
    const context = setup();
    const args = paidArgs(context, [
      '--no-slug',
      '--budget',
      '10',
      '--per-run',
      '1',
      '--margin',
      '0',
    ]);
    runEval(context, args);
    runEval(context, args);
    assert.deepEqual(
      ledgerLines(context.out).map((line) => line.noSlug),
      [true],
    );
    const sessions = stubSessions(context.recordDir);
    assert.deepEqual(
      sessions.map((session) => session.prompt),
      ['/orchestrate --auto'],
    );
    assert.ok(existsSync(join(context.out, 'no-slug', RUN_JSON)));
  });

  it('prints a line for each job the meter refuses', () => {
    const context = setup();
    const result = runEval(
      context,
      paidArgs(context, [
        '--samples',
        '2',
        '--no-slug',
        '--budget',
        '1',
        '--per-run',
        '1',
        '--margin',
        '0',
      ]),
    );
    assert.equal(ledgerLines(context.out).length, 1);
    assert.match(result.stdout, /^meter refused sample-2$/m);
    assert.match(result.stdout, /^meter refused no-slug$/m);
  });
});

describe('run preflight', () => {
  const preflightArgs = (context) =>
    paidArgs(context, [
      '--preflight',
      '--budget',
      '1',
      '--per-run',
      '0.02',
      '--margin',
      '1',
    ]);

  it('passes both probes on the API key and prints the margin', () => {
    const context = setup();
    const result = runEval(context, preflightArgs(context));
    assert.equal(result.status, EXIT_OK, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^probe a: pass, quoted true, files 1, /m);
    assert.match(result.stdout, /^probe b: pass, /m);
    assert.match(result.stdout, /^margin 0\.1$/m);
    assert.deepEqual(
      ledgerLines(context.out).map((line) => line.probe),
      ['a', 'b'],
    );
    const probeA = stubSessions(context.recordDir).find((session) =>
      session.prompt.startsWith('The repo CLAUDE.md'),
    );
    assert.equal(probeA.argv[probeA.argv.indexOf('--model') + 1], 'haiku');
    assert.equal(probeA.argv[probeA.argv.indexOf('--tools') + 1], '');
  });

  it('exits 2 when the meter refuses a probe', () => {
    const context = setup();
    const result = runEval(
      context,
      paidArgs(context, [
        '--preflight',
        '--budget',
        '0.04',
        '--per-run',
        '0.02',
        '--margin',
        '1',
      ]),
    );
    assert.equal(
      result.status,
      EXIT_NOT_STARTED,
      `${result.stdout}${result.stderr}`,
    );
    assert.match(result.stdout, /^meter refused probe-b$/m);
    assert.deepEqual(
      ledgerLines(context.out).map((line) => line.probe),
      ['a'],
    );
  });

  it('fails when a probe billed something other than the API key', () => {
    const context = setup();
    const result = runEval(context, preflightArgs(context), {
      EVAL_STUB_KEY_SOURCE: 'none',
    });
    assert.equal(result.status, EXIT_FAILED, result.stderr);
    assert.match(result.stdout, /^probe a: fail, .*apiKeySource none$/m);
    assert.match(result.stdout, /^probe b: fail, /m);
  });
});
