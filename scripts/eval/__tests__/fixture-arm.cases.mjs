// Cases for one eval slice. `scripts/__tests__/eval.test.mjs` imports this file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { LEDGER, RUN_JSON, VERDICT } from '../layout.mjs';
import { writeStubClaude } from './stub-claude.mjs';

const RUN_SCRIPT = new URL('../run.mjs', import.meta.url).pathname;
const EXIT_OK = 0;
const EXIT_NOT_STARTED = 2;
const WORKER_PATH = 'agents/task-worker.md';
const SKILL_PATH = 'skills/backlog-add/SKILL.md';
const INSTALLED_WORKER = 'installed worker\n';
const OVERLAY_WORKER = 'overlay worker wording\n';
const BACKLOG_LEDGER = '.claude/ledgers/backlog.jsonl';
const BACKLOG_ROW = '{"id":"QUE-1","action":"add"}';

/**
 * A stub `claude` that records each session's argv and cwd, then prints a result whose cost
 * and `by_type` come from `EVAL_STUB_COST` and `EVAL_STUB_BY_TYPE`. `EVAL_STUB_REWRITE` names a
 * file under the sample root to rewrite, and `EVAL_STUB_LEDGER_ROW` a row to append to the
 * backlog ledger.
 */
const STUB = writeStubClaude(`
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  console.log('9.9.9 (Claude Code)');
  process.exit(0);
}
const sessionId = randomUUID();
writeFileSync(join(process.env.EVAL_STUB_DIR, 'session-' + sessionId + '.json'),
  JSON.stringify({ argv, cwd: process.cwd() }));
if (process.env.EVAL_STUB_REWRITE) writeFileSync(process.env.EVAL_STUB_REWRITE, 'rewritten by the session\\n');
if (process.env.EVAL_STUB_LEDGER_ROW) {
  mkdirSync(dirname(${JSON.stringify(BACKLOG_LEDGER)}), { recursive: true });
  appendFileSync(${JSON.stringify(BACKLOG_LEDGER)}, process.env.EVAL_STUB_LEDGER_ROW + '\\n');
}
const emit = (event) => console.log(JSON.stringify({ session_id: sessionId, ...event }));
emit({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' });
emit({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  total_cost_usd: Number(process.env.EVAL_STUB_COST ?? '0.3'),
  subagent_stats: { by_type: JSON.parse(process.env.EVAL_STUB_BY_TYPE ?? '{"task-worker":1}') },
});
`);

function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), `hr-eval-arm-${prefix}-`));
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * A fake checkout whose `packages/cli/dist/cli.js` acts as `init`: it refuses a plugin module
 * unless the config names its alias by an absolute path holding a `package.json`, installs the
 * worker and the skill, and seeds a config with one target when none exists.
 */
function writeStubCheckout(base, recordDir) {
  const checkout = join(base, 'checkout');
  writeFile(
    join(checkout, 'packages', 'plugin-backlog', 'package.json'),
    '{}\n',
  );
  const cliPath = join(checkout, 'packages', 'cli', 'dist', 'cli.js');
  writeFile(
    cliPath,
    `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(recordDir, 'cli-calls'))}, argv.join(' ') + '\\n');
if (argv.slice(0, 3).join(' ') !== 'init --yes --modules') process.exit(3);
const modules = argv[3].split(',');
const configPath = '.claude/houserules.config.json';
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null;
for (const id of modules.filter((id) => id.includes('/'))) {
  const entry = config?.plugins?.find((plugin) => plugin.alias === id.split('/')[0]);
  if (!entry || !isAbsolute(entry.name) || !existsSync(join(entry.name, 'package.json'))) {
    console.error('Unknown module ' + id);
    process.exit(4);
  }
}
mkdirSync('.claude/agents', { recursive: true });
mkdirSync('.claude/skills/backlog-add', { recursive: true });
writeFileSync('.claude/${WORKER_PATH}', ${JSON.stringify(INSTALLED_WORKER)});
writeFileSync('.claude/${SKILL_PATH}', 'installed skill\\n');
writeFileSync('.claude/houserules.manifest.json', JSON.stringify({ files: {
  '.claude/${WORKER_PATH}': 'x', '.claude/${SKILL_PATH}': 'x' } }));
writeFileSync(configPath, JSON.stringify({ ...(config ?? { version: 2, targets: [{ name: 'stub' }] }), modules }));
`,
  );
  return { checkout, cliPath };
}

/**
 * A fixture with three arms. `a` and `b` overlay the worker, `sonnet` also names its own
 * model, and `stray` overlays a file `init` never installs.
 */
function writeFixture(base, overrides = {}) {
  const dir = join(base, 'fixture');
  writeFile(join(dir, 'repo', 'package.json'), '{"name":"fixture-repo"}\n');
  for (const arm of ['a', 'b', 'sonnet']) {
    writeFile(
      join(dir, 'arms', arm, 'prompt.txt'),
      `Prompt for ${arm}.\nSecond line.\n`,
    );
    writeFile(join(dir, 'arms', arm, 'overlay', WORKER_PATH), OVERLAY_WORKER);
  }
  writeFile(join(dir, 'arms', 'stray', 'prompt.txt'), 'Prompt for stray.\n');
  writeFile(
    join(dir, 'arms', 'stray', 'overlay', 'agents', 'never-installed.md'),
    'x\n',
  );
  const spec = {
    modules: 'plans,backlog/backlog',
    plugins: [{ path: 'packages/plugin-backlog', alias: 'backlog' }],
    model: 'haiku',
    validityAgent: 'task-worker',
    collect: [BACKLOG_LEDGER, '.claude/ledgers/decisions.jsonl'],
    arms: {
      a: { prompt: 'arms/a/prompt.txt', overlay: 'arms/a/overlay' },
      b: { prompt: 'arms/b/prompt.txt', overlay: 'arms/b/overlay' },
      sonnet: {
        prompt: 'arms/sonnet/prompt.txt',
        overlay: 'arms/sonnet/overlay',
        model: 'sonnet',
      },
      stray: { prompt: 'arms/stray/prompt.txt', overlay: 'arms/stray/overlay' },
    },
    ...overrides,
  };
  writeFile(join(dir, 'eval.json'), `${JSON.stringify(spec, null, 2)}\n`);
  return dir;
}

function setup() {
  const base = scratch('case');
  const recordDir = scratch('record');
  const keyFile = join(base, 'api-key');
  writeFileSync(keyFile, 'sk-eval-arm-key\n');
  chmodSync(keyFile, 0o600);
  return {
    base,
    recordDir,
    keyFile,
    work: join(base, 'work'),
    out: join(base, 'out'),
    home: scratch('home'),
    fixture: writeFixture(base),
    ...writeStubCheckout(base, recordDir),
  };
}

function runEval(context, args, extraEnv = {}) {
  const env = {
    ...process.env,
    PATH: STUB.path,
    HOME: context.home,
    HOUSERULES_EVAL_CLI: context.cliPath,
    EVAL_STUB_DIR: context.recordDir,
    ...extraEnv,
  };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [RUN_SCRIPT, ...args], {
    encoding: 'utf8',
    env,
  });
}

function armArgs(context, arm, extra) {
  return [
    '--fixture',
    context.fixture,
    '--arm',
    arm,
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

function readRun(out, arm, sample) {
  return JSON.parse(
    readFileSync(join(out, arm, `sample-${sample}`, RUN_JSON), 'utf8'),
  );
}

const ONE_SAMPLE = [
  '--samples',
  '1',
  '--budget',
  '10',
  '--per-run',
  '1',
  '--margin',
  '0',
];

describe('run --fixture refusals', () => {
  const cases = [
    {
      name: 'an unknown arm',
      error:
        /--arm "missing" is not in .*eval\.json, whose arms are a, b, sonnet, stray/,
      args: (context) => ['--fixture', context.fixture, '--arm', 'missing'],
    },
    {
      name: 'a fixture with no eval.json',
      error: /--fixture has no .*eval\.json/,
      args: (context) => ['--fixture', context.base, '--arm', 'a'],
    },
    {
      name: 'an arm whose prompt file is missing',
      error: /--fixture is missing .*nowhere\.txt/,
      args: () => [
        '--fixture',
        writeFixture(scratch('fixture'), {
          arms: { a: { prompt: 'nowhere.txt', overlay: 'arms/a/overlay' } },
        }),
        '--arm',
        'a',
      ],
    },
    {
      name: '--arm without --fixture',
      error: /--arm requires --fixture/,
      args: () => ['--arm', 'a'],
    },
    {
      name: '--fixture without --arm',
      error: /--fixture requires --arm/,
      args: (context) => ['--fixture', context.fixture],
    },
    {
      name: '--fixture with --preflight',
      error: /--fixture takes no --preflight, --no-slug, or --verdict-only/,
      args: (context) =>
        armArgs(context, 'a', [
          '--preflight',
          '--budget',
          '1',
          '--per-run',
          '0.02',
          '--margin',
          '0',
        ]),
    },
    {
      name: '--fixture with --no-slug',
      error: /--fixture takes no --preflight, --no-slug, or --verdict-only/,
      args: (context) => armArgs(context, 'a', ['--no-slug', ...ONE_SAMPLE]),
    },
    {
      name: '--fixture with --verdict-only',
      error: /--fixture takes no --preflight, --no-slug, or --verdict-only/,
      args: (context) => [
        '--fixture',
        context.fixture,
        '--arm',
        'a',
        '--verdict-only',
        '--out',
        context.out,
      ],
    },
  ];

  for (const refusal of cases) {
    it(`refuses ${refusal.name} with exit 2 before any init or session`, () => {
      const context = setup();
      const result = runEval(context, refusal.args(context));
      assert.equal(result.status, EXIT_NOT_STARTED, result.stdout);
      assert.match(result.stderr, refusal.error);
      assert.equal(existsSync(join(context.recordDir, 'cli-calls')), false);
      assert.equal(stubSessions(context.recordDir).length, 0);
      assert.equal(existsSync(join(context.out, LEDGER)), false);
    });
  }

  it('refuses an overlay path init did not install, and starts no session', () => {
    const context = setup();
    const result = runEval(context, armArgs(context, 'stray', ONE_SAMPLE));
    assert.equal(result.status, EXIT_NOT_STARTED, result.stdout);
    assert.match(
      result.stderr,
      /names agents\/never-installed\.md, which init did not install under \.claude\//,
    );
    assert.equal(stubSessions(context.recordDir).length, 0);
    assert.deepEqual(ledgerLines(context.out), []);
  });
});

describe('run --fixture free default', () => {
  it('assembles the arm sample with plugins by absolute path and prints one claude -p line', () => {
    const context = setup();
    const result = runEval(context, [
      '--fixture',
      context.fixture,
      '--arm',
      'a',
      '--work',
      context.work,
    ]);
    assert.equal(result.status, EXIT_OK, result.stderr);
    const commandLines = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('claude '));
    assert.equal(commandLines.length, 1, result.stdout);
    assert.ok(
      commandLines[0].startsWith(
        `claude -p $'Prompt for a.\\nSecond line.\\n' --model haiku `,
      ),
      commandLines[0],
    );
    const root = /^sample root (.+)$/m.exec(result.stdout)[1];
    assert.match(root, /[\\/]a[\\/]sample-1$/);
    const config = JSON.parse(
      readFileSync(join(root, '.claude', 'houserules.config.json'), 'utf8'),
    );
    assert.deepEqual(config.plugins, [
      {
        name: join(context.checkout, 'packages', 'plugin-backlog'),
        alias: 'backlog',
      },
    ]);
    assert.deepEqual(config.targets, [{ name: 'stub' }]);
    assert.equal(
      readFileSync(join(root, '.claude', WORKER_PATH), 'utf8'),
      OVERLAY_WORKER,
    );
    const committed = spawnSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(committed.stdout, '');
    assert.equal(existsSync(context.out), false);
    assert.equal(stubSessions(context.recordDir).length, 0);
  });
});

describe('run --fixture validity', () => {
  it('counts a sample whose by_type holds the fixture validityAgent as valid', () => {
    const context = setup();
    const first = runEval(context, armArgs(context, 'a', ONE_SAMPLE));
    assert.equal(first.status, EXIT_OK, first.stderr);
    assert.match(first.stdout, /^a\/sample-1: valid$/m);
    const rerun = runEval(context, armArgs(context, 'a', ONE_SAMPLE));
    assert.equal(rerun.status, EXIT_OK, rerun.stderr);
    assert.equal(stubSessions(context.recordDir).length, 1);
    const run = readRun(context.out, 'a', 1);
    assert.equal(run.validityAgent, 'task-worker');
    assert.equal(run.prompt, 'Prompt for a.\nSecond line.\n');
    assert.equal('leftTree' in run, false);
    assert.equal(existsSync(join(context.out, VERDICT)), false);
  });

  it('voids a sample whose by_type lacks the fixture validityAgent', () => {
    const context = setup();
    const stubEnv = { EVAL_STUB_BY_TYPE: '{"phase-orchestrator":1}' };
    const first = runEval(context, armArgs(context, 'a', ONE_SAMPLE), stubEnv);
    assert.equal(first.status, EXIT_OK, first.stderr);
    assert.match(first.stdout, /^a\/sample-1: void, no task-worker spawned$/m);
    runEval(context, armArgs(context, 'a', ONE_SAMPLE), stubEnv);
    assert.deepEqual(
      ledgerLines(context.out).map((line) => line.sample),
      [1, 2],
    );
  });

  it('voids a sample whose session rewrote an overlaid file, and records its three hashes', () => {
    const context = setup();
    const result = runEval(context, armArgs(context, 'a', ONE_SAMPLE), {
      EVAL_STUB_REWRITE: join('.claude', WORKER_PATH),
    });
    assert.equal(result.status, EXIT_OK, result.stderr);
    assert.match(
      result.stdout,
      /^a\/sample-1: void, overlay rewritten: agents\/task-worker\.md$/m,
    );
    assert.deepEqual(readRun(context.out, 'a', 1).overlays, [
      {
        path: WORKER_PATH,
        initSha256: sha256(INSTALLED_WORKER),
        overlaySha256: sha256(OVERLAY_WORKER),
        exitSha256: sha256('rewritten by the session\n'),
      },
    ]);
  });
});

describe('run --fixture arms on one --out', () => {
  it('meters both arms against the whole ledger: a starts 2, then b starts exactly 1', () => {
    const context = setup();
    const budget = [
      '--samples',
      '2',
      '--budget',
      '1',
      '--per-run',
      '0.30',
      '--margin',
      '0',
    ];
    const armA = runEval(context, armArgs(context, 'a', budget), {
      EVAL_STUB_COST: '0.30',
    });
    assert.equal(armA.status, EXIT_OK, armA.stderr);
    const armB = runEval(context, armArgs(context, 'b', budget), {
      EVAL_STUB_COST: '0.30',
    });
    assert.equal(armB.status, EXIT_NOT_STARTED, armB.stderr);
    assert.match(armB.stdout, /^meter refused b\/sample-2$/m);
    const lines = ledgerLines(context.out);
    assert.deepEqual(
      lines.map((line) => Object.keys(line)),
      Array.from({ length: 3 }, () => [
        'arm',
        'sample',
        'sessionId',
        'costUsd',
      ]),
    );
    assert.deepEqual(
      lines.map((line) => [line.arm, line.sample, line.costUsd]),
      [
        ['a', 1, 0.3],
        ['a', 2, 0.3],
        ['b', 1, 0.3],
      ],
    );
    assert.ok(existsSync(join(context.out, 'b', 'sample-1', 'stream.jsonl')));
    assert.equal(existsSync(join(context.out, 'b', 'sample-2')), false);
  });

  it('keeps --preflight working on the --out the arms use', () => {
    const context = setup();
    runEval(context, armArgs(context, 'a', ONE_SAMPLE));
    const preflight = runEval(context, [
      '--paid',
      '--preflight',
      '--api-key-file',
      context.keyFile,
      '--work',
      context.work,
      '--out',
      context.out,
      '--budget',
      '10',
      '--per-run',
      '0.02',
      '--margin',
      '1',
    ]);
    assert.match(preflight.stdout, /^probe b: /m, preflight.stderr);
    assert.deepEqual(
      ledgerLines(context.out).map((line) => line.arm ?? `probe-${line.probe}`),
      ['a', 'probe-a', 'probe-b'],
    );
  });
});

describe('run --fixture model', () => {
  it('passes the arm model when set, and the fixture model otherwise', () => {
    const context = setup();
    runEval(context, armArgs(context, 'sonnet', ONE_SAMPLE));
    runEval(context, armArgs(context, 'a', ONE_SAMPLE));
    const models = stubSessions(context.recordDir)
      .map((session) => session.argv[session.argv.indexOf('--model') + 1])
      .sort();
    assert.deepEqual(models, ['haiku', 'sonnet']);
    assert.equal(readRun(context.out, 'sonnet', 1).model, 'sonnet');
    assert.equal(readRun(context.out, 'a', 1).model, 'haiku');
  });
});

describe('run --fixture collect', () => {
  it('copies a collect path the session wrote into tree/, and skips one it never wrote', () => {
    const context = setup();
    const result = runEval(context, armArgs(context, 'a', ONE_SAMPLE), {
      EVAL_STUB_LEDGER_ROW: BACKLOG_ROW,
    });
    assert.equal(result.status, EXIT_OK, result.stderr);
    const tree = join(context.out, 'a', 'sample-1', 'tree');
    assert.equal(
      readFileSync(join(tree, BACKLOG_LEDGER), 'utf8'),
      `${BACKLOG_ROW}\n`,
    );
    assert.equal(
      existsSync(join(tree, '.claude', 'ledgers', 'decisions.jsonl')),
      false,
    );
  });
});
