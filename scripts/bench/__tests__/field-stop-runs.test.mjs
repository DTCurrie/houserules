import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'field-stop-runs.mjs',
);
const STATUS = 'Running lint/format auto-fix';
const OLD_STATUS = 'Running lint:fix + format:fix';
const OTHER_HOOK = {
  command: '[ -f x ] && exec node x.mjs || exit 0',
  durationMs: 40,
};

let work;
let counter = 0;

const FILLER_LINES_PER_SIDE = 50_000;
const FILLER_TIME = '2026-11-01T12:00:00.000Z';

const slugify = (text) => text.replace(/[^a-zA-Z0-9]/g, '-');

function runGit(cwd, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function commit(root, message, date) {
  const env = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  runGit(root, ['add', '-A'], { env });
  runGit(
    root,
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '-m',
      message,
    ],
    { env },
  );
}

/** A git repo under the work dir, with origin when `origin` is given. */
function makeRepo(path, origin) {
  mkdirSync(path, { recursive: true });
  runGit(path, ['init', '-q']);
  if (origin) runGit(path, ['remote', 'add', 'origin', origin]);
  return path;
}

function writeFileEnsuringDirectory(root, file, text) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function freshDirs() {
  counter += 1;
  const base = join(work, `case-${counter}`);
  const projects = join(base, 'projects');
  mkdirSync(projects, { recursive: true });
  return { base, projects };
}

function writeTranscript(projects, cwd, session, records, raw = []) {
  const dir = join(projects, slugify(cwd));
  mkdirSync(dir, { recursive: true });
  const lines = [
    ...records.map((record) =>
      JSON.stringify({ cwd, sessionId: session, ...record }),
    ),
    ...raw,
  ];
  writeFileSync(join(dir, `${session}.jsonl`), `${lines.join('\n')}\n`);
}

const summary = (timestamp, hookInfos, extra = {}) => ({
  type: 'system',
  subtype: 'stop_hook_summary',
  timestamp,
  version: '2.1.330',
  hookInfos,
  hookErrors: [],
  preventedContinuation: false,
  ...extra,
});

const fixerInfo = (durationMs, field = 'command', text = STATUS) => ({
  [field]: text,
  ...(durationMs === undefined ? {} : { durationMs }),
});

const prompt = (timestamp) => ({
  type: 'user',
  timestamp,
  message: { role: 'user', content: 'go' },
});

const toolUse = (name, input, timestamp = '2026-11-01T00:00:01.000Z') => ({
  type: 'assistant',
  timestamp,
  message: { content: [{ type: 'tool_use', id: `t${counter}`, name, input }] },
});

function buriedInFiller(timestamp) {
  const filler = Array(FILLER_LINES_PER_SIDE).fill(
    JSON.stringify({ timestamp: FILLER_TIME }),
  );
  return [...filler, JSON.stringify({ timestamp }), ...filler];
}

function extract(names, projects, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, ...names, '--projects-dir', projects, ...extraArgs],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    meta: lines.find((line) => line.kind === 'meta'),
    repos: lines.filter((line) => line.kind === 'repo'),
    runs: lines.filter((line) => line.kind === 'run'),
  };
}

describe('field-stop-runs', () => {
  before(() => {
    work = realpathSync(mkdtempSync(join(tmpdir(), 'field-stop-runs-')));
  });
  after(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('accepts every way a fixer entry is named and finds it among several hooks', () => {
    const { base, projects } = freshDirs();
    const root = makeRepo(join(base, 'alpha'));
    writeTranscript(projects, root, 's1', [
      prompt('2026-11-01T00:00:00.000Z'),
      summary('2026-11-01T00:01:00.000Z', [fixerInfo(10)]),
      summary('2026-11-01T00:02:00.000Z', [
        fixerInfo(20, 'command', OLD_STATUS),
      ]),
      summary('2026-11-01T00:03:00.000Z', [
        { command: 'node a.mjs', statusMessage: STATUS, durationMs: 30 },
      ]),
      summary('2026-11-01T00:04:00.000Z', [
        {
          command: 'node "$DIR/.claude/scripts/lint-format-fix.mjs"',
          durationMs: 40,
        },
      ]),
      summary('2026-11-01T00:05:00.000Z', [
        OTHER_HOOK,
        fixerInfo(50),
        OTHER_HOOK,
      ]),
      summary('2026-11-01T00:06:00.000Z', [OTHER_HOOK]),
    ]);
    const { meta, runs } = extract(['alpha'], projects);
    assert.deepEqual(
      runs.map((record) => record.durationMs),
      [10, 20, 30, 40, 50],
    );
    assert.equal(meta.summaryRecords, 6);
    assert.equal(meta.schema, 'stop-runs@1');
    assert.equal(meta.transcripts, 1);
    assert.equal(meta.oldest, '2026-11-01T00:00:00.000Z');
    assert.equal(meta.newest, '2026-11-01T00:06:00.000Z');
  });

  it('reports the time span of transcripts holding more timestamps than a function call accepts as arguments', () => {
    const { base, projects } = freshDirs();
    const root = makeRepo(join(base, 'alpha'));
    writeTranscript(
      projects,
      root,
      's1',
      [prompt(FILLER_TIME)],
      buriedInFiller('2026-11-01T00:00:00.000Z'),
    );
    writeTranscript(
      projects,
      root,
      's2',
      [prompt(FILLER_TIME)],
      buriedInFiller('2026-11-02T00:00:00.000Z'),
    );

    const { meta } = extract(['alpha'], projects);

    assert.deepEqual(
      { oldest: meta.oldest, newest: meta.newest },
      {
        oldest: '2026-11-01T00:00:00.000Z',
        newest: '2026-11-02T00:00:00.000Z',
      },
      'two transcripts of 100,002 timestamps each sum past the roughly 125,000 arguments one call takes',
    );
  });

  it('buckets durations at their bounds and treats a missing durationMs as unknown', () => {
    const { base, projects } = freshDirs();
    const root = makeRepo(join(base, 'alpha'));
    const durations = [
      89_999,
      90_000,
      119_999,
      120_000,
      124_999,
      125_000,
      undefined,
    ];
    writeTranscript(
      projects,
      root,
      's1',
      durations.map((d, i) =>
        summary(`2026-11-01T00:0${i}:00.000Z`, [fixerInfo(d)]),
      ),
    );
    const { runs } = extract(['alpha'], projects);
    assert.deepEqual(
      runs.map((record) => [record.durationMs, record.bucket]),
      [
        [89_999, 'under'],
        [90_000, 'over-budget'],
        [119_999, 'over-budget'],
        [120_000, 'at-timeout'],
        [124_999, 'at-timeout'],
        [125_000, 'past-timeout'],
        [null, 'unknown'],
      ],
    );
  });

  it('keeps a run with no timestamp and skips a malformed line', () => {
    const { base, projects } = freshDirs();
    const root = makeRepo(join(base, 'alpha'));
    writeTranscript(
      projects,
      root,
      's1',
      [
        summary(undefined, [fixerInfo(5)]),
        summary('2026-11-01T00:01:00.000Z', [fixerInfo(6)]),
      ],
      ['{not json'],
    );
    const { runs } = extract(['alpha'], projects);
    assert.deepEqual(
      runs
        .map((record) => [record.durationMs, record.ts])
        .sort((a, b) => a[0] - b[0]),
      [
        [5, null],
        [6, '2026-11-01T00:01:00.000Z'],
      ],
    );
    assert.equal(
      runs.find((record) => record.durationMs === 5).fixerInForce.source,
      'unknown',
    );
  });

  it('joins a session started in a subdirectory to its repo and keeps only exact names', () => {
    const { base, projects } = freshDirs();
    const app = makeRepo(join(base, 'app'));
    const myApp = makeRepo(join(base, 'my-app'));
    mkdirSync(join(app, 'packages', 'ui'), { recursive: true });
    writeTranscript(projects, join(app, 'packages', 'ui'), 's1', [
      summary('2026-11-01T00:01:00.000Z', [fixerInfo(1)]),
    ]);
    writeTranscript(projects, myApp, 's2', [
      summary('2026-11-01T00:02:00.000Z', [fixerInfo(2)]),
    ]);
    const { repos, runs } = extract(['app'], projects);
    assert.deepEqual(
      repos.map((record) => [record.repo, record.root, record.sessions]),
      [['app', app, 1]],
    );
    assert.deepEqual(
      runs.map((record) => [record.repo, record.durationMs]),
      [['app', 1]],
    );
  });

  it('counts fixer runs from other sessions whose windows overlap', () => {
    const { base, projects } = freshDirs();
    const root = makeRepo(join(base, 'alpha'));
    writeTranscript(projects, root, 's1', [
      summary('2026-11-01T00:01:00.000Z', [fixerInfo(30_000)]),
    ]);
    writeTranscript(projects, root, 's2', [
      summary('2026-11-01T00:01:10.000Z', [fixerInfo(30_000)]),
      summary('2026-11-01T01:00:00.000Z', [fixerInfo(1_000)]),
    ]);
    const { runs } = extract(['alpha'], projects);
    assert.deepEqual(
      runs.map((record) => [
        record.file.split('/').at(-1),
        record.overlappingRuns,
      ]),
      [
        ['s1.jsonl', 1],
        ['s2.jsonl', 1],
        ['s2.jsonl', 0],
      ],
    );
  });

  it('lists distinct edited paths once and the targets they fall under', () => {
    const { base, projects } = freshDirs();
    const root = makeRepo(join(base, 'alpha'));
    writeFileEnsuringDirectory(
      root,
      '.claude/houserules.config.json',
      JSON.stringify({
        fix: { commands: ['lint:fix'] },
        targets: [
          { pathPrefix: 'packages/ui/', packageName: 'ui' },
          { pathPrefix: 'packages/db/', packageName: 'db' },
        ],
      }),
    );
    writeTranscript(projects, root, 's1', [
      prompt('2026-11-01T00:00:00.000Z'),
      toolUse('Edit', { file_path: join(root, 'packages/ui/a.ts') }),
      toolUse('Edit', { file_path: join(root, 'packages/ui/a.ts') }),
      toolUse('NotebookEdit', { notebook_path: join(root, 'docs/n.ipynb') }),
      toolUse('Read', { file_path: join(root, 'packages/db/read.ts') }),
      summary('2026-11-01T00:01:00.000Z', [fixerInfo(7)]),
      prompt('2026-11-01T00:02:00.000Z'),
      toolUse('Write', { file_path: join(root, 'packages/db/b.ts') }),
      summary('2026-11-01T00:03:00.000Z', [fixerInfo(8)]),
    ]);
    const { runs } = extract(['alpha'], projects);
    assert.deepEqual(runs[0].editedPaths, ['packages/ui/a.ts', 'docs/n.ipynb']);
    assert.deepEqual(runs[0].targets, ['packages/ui/']);
    assert.deepEqual(runs[1].editedPaths, ['packages/db/b.ts']);
    assert.deepEqual(runs[1].targets, ['packages/db/']);
  });

  it('writes no home directory and no user name into any output line', () => {
    const { base, projects } = freshDirs();
    const home = join(base, 'home', 'zebulon');
    const root = makeRepo(join(home, 'Projects', 'alpha'));
    writeTranscript(projects, root, 's1', [
      prompt('2026-11-01T00:00:00.000Z'),
      toolUse('Edit', { file_path: join(root, 'src/a.ts') }),
      toolUse('Edit', { file_path: join(home, 'notes/todo.md') }),
      toolUse('Edit', { file_path: '/Users/mallory/other.md' }),
      summary('2026-11-01T00:01:00.000Z', [fixerInfo(7)]),
    ]);
    const result = spawnSync(
      process.execPath,
      [SCRIPT, 'alpha', '--projects-dir', projects, '--home', home],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(home));
    assert.ok(!result.stdout.includes('zebulon'));
    assert.ok(!result.stdout.includes('mallory'));
    const lines = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const repo = lines.find((line) => line.kind === 'repo');
    const run = lines.find((line) => line.kind === 'run');
    assert.equal(repo.root, '~/Projects/alpha');
    assert.deepEqual(run.editedPaths, [
      'src/a.ts',
      '~/notes/todo.md',
      '/Users/<user>/other.md',
    ]);
    assert.ok(run.file.includes('-home-<user>-Projects-alpha/s1.jsonl'));
  });

  it('counts pulls, switches, and installs since the previous fixer run', () => {
    const { base, projects } = freshDirs();
    const root = makeRepo(join(base, 'alpha'));
    const bash = (command) => toolUse('Bash', { command });
    writeTranscript(projects, root, 's1', [
      bash('git pull'),
      bash('pnpm install'),
      bash('ls'),
      summary('2026-11-01T00:01:00.000Z', [fixerInfo(1)]),
      bash('gh pr checkout 12'),
      summary('2026-11-01T00:02:00.000Z', [fixerInfo(1)]),
    ]);
    const { runs } = extract(['alpha'], projects);
    assert.deepEqual(
      runs.map((record) => record.bashChurn),
      [2, 1],
    );
  });

  it('reads the fixer in force from a tracked fixer whose history gains a budget and detached', () => {
    const { base, projects } = freshDirs();
    const root = makeRepo(join(base, 'alpha'));
    const fixer = '.claude/scripts/lint-format-fix.mjs';
    writeFileEnsuringDirectory(root, fixer, 'const a = 1;\n');
    commit(root, 'one', '2026-10-01T00:00:00Z');
    writeFileEnsuringDirectory(root, fixer, 'const FIX_BUDGET_MS = 90_000;\n');
    commit(root, 'two', '2026-10-15T00:00:00Z');
    writeFileEnsuringDirectory(
      root,
      fixer,
      'const FIX_BUDGET_MS = 90_000;\nspawn(x, { detached: true });\n',
    );
    commit(root, 'three', '2026-11-10T00:00:00Z');
    writeTranscript(
      projects,
      root,
      's1',
      [
        '2026-10-05T00:00:00.000Z',
        '2026-10-20T00:00:00.000Z',
        '2026-11-15T00:00:00.000Z',
      ].map((ts) => summary(ts, [fixerInfo(1)])),
    );
    const { repos, runs } = extract(['alpha'], projects);
    assert.deepEqual(
      repos[0].fixerHistory.map((v) => [v.fixBudgetMs, v.detached]),
      [
        [null, false],
        [90_000, false],
        [90_000, true],
      ],
    );
    assert.deepEqual(
      runs.map((record) => [
        record.fixerInForce.source,
        record.fixerInForce.fixBudgetMs,
        record.fixerInForce.detached,
      ]),
      [
        ['fixer-history', null, false],
        ['fixer-history', 90_000, false],
        ['fixer-history', 90_000, true],
      ],
    );
  });

  it('reads the fixer in force from a tracked manifest when the fixer is untracked', () => {
    const { base, projects } = freshDirs();
    const root = makeRepo(join(base, 'alpha'));
    writeFileEnsuringDirectory(root, '.gitignore', '.claude/scripts/\n');
    writeFileEnsuringDirectory(
      root,
      '.claude/scripts/lint-format-fix.mjs',
      'x\n',
    );
    const manifestPath = '.claude/houserules.manifest.json';
    writeFileEnsuringDirectory(
      root,
      manifestPath,
      JSON.stringify({
        kitVersion: '0.15.0',
        installedAt: '2026-11-01T00:00:00.000Z',
      }),
    );
    commit(root, 'a', '2026-11-01T00:00:00Z');
    writeFileEnsuringDirectory(
      root,
      manifestPath,
      JSON.stringify({
        kitVersion: '0.16.0',
        installedAt: '2026-11-20T00:00:00.000Z',
      }),
    );
    commit(root, 'b', '2026-11-20T00:00:00Z');
    writeTranscript(
      projects,
      root,
      's1',
      [
        '2026-10-30T00:00:00.000Z',
        '2026-11-05T00:00:00.000Z',
        '2026-11-21T00:00:00.000Z',
      ].map((ts) => summary(ts, [fixerInfo(1)])),
    );
    const { repos, runs } = extract(['alpha'], projects);
    assert.deepEqual(repos[0].fixerHistory, []);
    assert.deepEqual(
      repos[0].manifestHistory.map((v) => v.kitVersion),
      ['0.15.0', '0.16.0'],
    );
    assert.deepEqual(
      runs.map(
        (record) =>
          record.fixerInForce.kitVersion ?? record.fixerInForce.source,
      ),
      ['unknown', '0.15.0', '0.16.0'],
    );
  });

  it('falls back to the @houserules/cli version, and to unknown with neither', () => {
    const { base, projects } = freshDirs();
    const withCli = makeRepo(join(base, 'withcli'));
    writeFileEnsuringDirectory(
      withCli,
      'package.json',
      JSON.stringify({ devDependencies: { '@houserules/cli': '^0.14.0' } }),
    );
    commit(withCli, 'a', '2026-11-01T00:00:00Z');
    const bare = makeRepo(join(base, 'bare'));
    for (const [root, session] of [
      [withCli, 's1'],
      [bare, 's2'],
    ])
      writeTranscript(projects, root, session, [
        summary('2026-11-05T00:00:00.000Z', [fixerInfo(1)]),
      ]);
    const { runs } = extract(['withcli', 'bare'], projects);
    assert.deepEqual(
      runs.map((record) => [record.repo, record.fixerInForce]),
      [
        ['bare', { source: 'unknown' }],
        ['withcli', { source: 'package-json', cliVersion: '^0.14.0' }],
      ],
    );
  });

  it('reads verify-deps-before-run from .npmrc and verifyDepsBeforeRun from pnpm-workspace.yaml', () => {
    const { base, projects } = freshDirs();
    const npmrc = makeRepo(join(base, 'npmrc'));
    writeFileEnsuringDirectory(
      npmrc,
      '.npmrc',
      'verify-deps-before-run=false\n',
    );
    const yaml = makeRepo(join(base, 'yaml'));
    writeFileEnsuringDirectory(
      yaml,
      'pnpm-workspace.yaml',
      'packages:\n  - a\nverifyDepsBeforeRun: install\n',
    );
    for (const [root, session] of [
      [npmrc, 's1'],
      [yaml, 's2'],
    ])
      writeTranscript(projects, root, session, [
        summary('2026-11-05T00:00:00.000Z', [fixerInfo(1)]),
      ]);
    const { repos } = extract(['npmrc', 'yaml'], projects);
    assert.deepEqual(
      repos.map((record) => [record.repo, record.verifyDepsBeforeRun]),
      [
        ['npmrc', { value: 'false', file: '.npmrc' }],
        ['yaml', { value: 'install', file: 'pnpm-workspace.yaml' }],
      ],
    );
  });

  it('records fix config, scripts, packageManager, and tracked file count per repo', () => {
    const { base, projects } = freshDirs();
    const root = makeRepo(join(base, 'alpha'));
    writeFileEnsuringDirectory(
      root,
      'package.json',
      JSON.stringify({
        packageManager: 'pnpm@10.0.0',
        scripts: { 'lint:fix': 'eslint . --fix' },
      }),
    );
    writeFileEnsuringDirectory(
      root,
      'packages/ui/package.json',
      JSON.stringify({ scripts: { 'lint:fix': 'eslint src --fix' } }),
    );
    writeFileEnsuringDirectory(
      root,
      '.claude/houserules.config.json',
      JSON.stringify({
        fix: { runner: 'pnpm', commands: ['lint:fix', 'format'] },
        targets: [{ pathPrefix: 'packages/ui/', packageName: 'ui' }],
      }),
    );
    commit(root, 'a', '2026-11-01T00:00:00Z');
    writeTranscript(projects, root, 's1', [
      summary('2026-11-05T00:00:00.000Z', [fixerInfo(1)]),
    ]);
    const [repo] = extract(['alpha'], projects).repos;
    assert.equal(repo.trackedFiles, 3);
    assert.equal(repo.packageManager, 'pnpm@10.0.0');
    assert.deepEqual(repo.fix, {
      runner: 'pnpm',
      commands: ['lint:fix', 'format'],
    });
    assert.deepEqual(repo.scripts, {
      root: { 'lint:fix': 'eslint . --fix', format: null },
      targets: {
        'packages/ui/': { 'lint:fix': 'eslint src --fix', format: null },
      },
    });
  });

  it('carries a Stop-hook attachment, and null where the transcript has none', () => {
    const { base, projects } = freshDirs();
    const root = makeRepo(join(base, 'alpha'));
    writeTranscript(projects, root, 'with', [
      {
        type: 'attachment',
        timestamp: '2026-11-01T00:01:00.500Z',
        attachment: {
          type: 'hook_non_blocking_error',
          hookEvent: 'Stop',
          hookName: 'Stop',
          command: STATUS,
          exitCode: 1,
          stderr: 'boom',
          stdout: '',
          content: 'lint failed',
          durationMs: 4321,
        },
      },
      summary('2026-11-01T00:01:00.000Z', [fixerInfo(4321)], {
        hookErrors: [`[${STATUS}]: ${'x'.repeat(400)}`],
      }),
    ]);
    writeTranscript(projects, root, 'without', [
      summary('2026-11-02T00:01:00.000Z', [fixerInfo(5)]),
    ]);
    const { runs } = extract(['alpha'], projects);
    const withRun = runs.find((record) => record.file.endsWith('with.jsonl'));
    assert.deepEqual(withRun.attachment, {
      type: 'hook_non_blocking_error',
      exitCode: 1,
      stderr: 'boom',
      stdout: '',
      durationMs: 4321,
      content: 'lint failed',
    });
    assert.equal(withRun.hookErrors[0], 'x'.repeat(300));
    assert.equal(
      runs.find((record) => record.file.endsWith('without.jsonl')).attachment,
      null,
    );
  });

  it('reports the transcript byte size before the run record', () => {
    const { base, projects } = freshDirs();
    const root = makeRepo(join(base, 'alpha'));
    writeTranscript(projects, root, 's1', [
      prompt('2026-11-01T00:00:00.000Z'),
      summary('2026-11-01T00:01:00.000Z', [fixerInfo(1)]),
    ]);
    const file = join(projects, slugify(root), 's1.jsonl');
    const text = readFileSync(file, 'utf8');
    const { runs } = extract(['alpha'], projects);
    assert.equal(
      runs[0].transcriptBytes,
      Buffer.byteLength(text.split('\n')[0]) + 1,
    );
  });

  it('reduces ssh and https origins of two clones to one remote, null without origin', () => {
    const { base, projects } = freshDirs();
    const one = makeRepo(
      join(base, 'one', 'widgets'),
      'git@github.com:acme/widgets.git',
    );
    const two = makeRepo(
      join(base, 'two', 'widgets'),
      'https://github.com/acme/widgets',
    );
    const none = makeRepo(join(base, 'three', 'solo'));
    writeTranscript(projects, one, 's1', [
      summary('2026-11-01T00:01:00.000Z', [fixerInfo(1)]),
    ]);
    writeTranscript(projects, two, 's2', [
      summary('2026-11-01T00:02:00.000Z', [fixerInfo(2)]),
    ]);
    writeTranscript(projects, none, 's3', [
      summary('2026-11-01T00:03:00.000Z', [fixerInfo(3)]),
    ]);
    const { repos, runs } = extract(['widgets', 'solo'], projects);
    assert.deepEqual(
      repos.map((record) => [record.root, record.remote]),
      [
        [one, 'acme/widgets'],
        [none, null],
        [two, 'acme/widgets'],
      ],
    );
    assert.deepEqual(
      runs.map((record) => record.remote),
      ['acme/widgets', 'acme/widgets', null],
    );
  });

  it('runs from stdin with `node --input-type=module -` and writes nothing', () => {
    const { base, projects } = freshDirs();
    const root = makeRepo(join(base, 'alpha'));
    writeTranscript(projects, root, 's1', [
      summary('2026-11-01T00:01:00.000Z', [fixerInfo(9)]),
    ]);
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-', 'alpha', '--projects-dir', projects],
      { input: readFileSync(SCRIPT, 'utf8'), encoding: 'utf8', cwd: base },
    );
    assert.equal(result.status, 0, result.stderr);
    const runs = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((line) => line.kind === 'run');
    assert.deepEqual(
      runs.map((record) => record.durationMs),
      [9],
    );
  });
});
