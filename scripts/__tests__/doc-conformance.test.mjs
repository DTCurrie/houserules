import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../health-kit/gather/doc-conformance.mjs',
);

const PHASE_OK = `# Phase 1: ok

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)

## Slices

| id  | owns | status |
| --- | ---- | ------ |
| 1a  | x    | TODO   |
`;
const PHASE_BAD = PHASE_OK.replace('| TODO   |', '| WIP    |');
const roadmapFor = (name) => `# ROADMAP: ${name}

**Status:** IN PROGRESS · **Started:** 2026-11-20 · **Updated:** 2026-11-20

## Phases

- [ ] **Phase 1: ok** · Status: TODO · [sub-plan](phase-1-ok.md) · After: none
`;
const findingBlock = (id, evidence) => `# Findings

### ${id} Something
- **tag:** quality
- **surface:** \`a.md\`
- **evidence:** ${evidence}
- **version gate:** none
- **candidate action:** park
- **destination:** none
- **cost:** low
`;
const changesetWith = (summary) => `---\n'@x/pkg': patch\n---\n\n${summary}\n`;

let repo;
let issuesPath;
let result;

function put(path, text) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}
const git = (...args) =>
  execFileSync(
    'git',
    ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    {
      stdio: 'ignore',
      env: { ...process.env, GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' },
    },
  );
const rowFor = (name) => result.kinds.find((row) => row.kind === name);

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'doc-conformance-test-'));
  git('init', '-q');
  put('.claude/plans/good/ROADMAP.md', roadmapFor('good'));
  put('.claude/plans/good/phase-1-ok.md', PHASE_OK);
  put('.claude/plans/_archive/bad/ROADMAP.md', roadmapFor('bad'));
  put('.claude/plans/_archive/bad/phase-1-ok.md', PHASE_BAD);
  put('.claude/plans/good/ok-findings.md', findingBlock('AA-01', 'ran `ls`'));
  put(
    '.claude/plans/good/bad-findings.md',
    findingBlock('AA-01', 'it felt slow'),
  );
  put('.changeset/good.md', changesetWith('Adds a flag.'));
  put('.changeset/bad.md', changesetWith('Adds a flag; removes another.'));
  put('.changeset/README.md', 'ignored; not a changeset\n');
  put('.changeset/first.md', changesetWith('Fixes a crash.'));
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  put('.changeset/second.md', changesetWith('Adds a flag; removes another.'));
  git('add', '-A');
  execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '-m',
      'two',
    ],
    {
      stdio: 'ignore',
      env: { ...process.env, GIT_COMMITTER_DATE: '2022-01-01T00:00:00Z' },
    },
  );
  issuesPath = join(repo, 'issues.json');
  writeFileSync(
    issuesPath,
    JSON.stringify([
      { number: 1, title: 'ok', body: 'A plain sentence.', labels: [] },
      { number: 2, title: 'bad', body: 'One; two.', labels: [] },
      {
        number: 3,
        title: 'marked',
        body: 'A plain sentence.\n\n<!-- houserules:entry:CLI-72633f -->',
        labels: [],
      },
      {
        number: 4,
        title: 'leaky',
        body: 'Tracks CLI-72633f here.\n\n<!-- houserules:entry:CLI-72633f -->',
        labels: [],
      },
    ]),
  );
  const out = join(repo, 'out.json');
  const run = spawnSync(
    'node',
    [SCRIPT, '--repo', repo, '--issues', issuesPath, '--json', out],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  result = JSON.parse(readFileSync(out, 'utf8'));
});

after(() => rmSync(repo, { recursive: true, force: true }));

describe('doc-conformance', () => {
  it('writes the schema tag and one row per kind', () => {
    assert.equal(result.schema, 'doc-conformance@1');
    assert.deepEqual(
      result.kinds.map((row) => row.kind),
      ['plan', 'changeset-disk', 'changeset-history', 'issue', 'findings'],
    );
  });

  it('plan: one workspace passes, the archived one fails plan-lint', () => {
    const row = rowFor('plan');
    assert.equal(row.documents, 2);
    assert.equal(row.passed, 1);
    assert.equal(row.share, 0.5);
    assert.deepEqual(
      row.rules.map((rule) => rule.rule),
      ['plan-lint/slice-status-vocabulary'],
    );
    assert.deepEqual(row.rules[0].examples, ['.claude/plans/_archive/bad']);
  });

  it('changeset-disk: the one-sentence file passes, the semicolon file fails', () => {
    const row = rowFor('changeset-disk');
    assert.equal(row.documents, 4);
    assert.equal(row.passed, 2);
    assert.equal(row.share, 0.5);
    assert.deepEqual(
      row.rules.map((rule) => rule.rule),
      ['prose-voice/no-semicolons'],
    );
  });

  it('changeset-history: reads added files from git and filters by --before', () => {
    const row = rowFor('changeset-history');
    assert.equal(row.documents, 4);
    assert.equal(row.passed, 2);
    assert.equal(row.rules[0].rule, 'prose-voice/no-semicolons');
    const out = join(repo, 'before.json');
    const run = spawnSync(
      'node',
      [
        SCRIPT,
        '--repo',
        repo,
        '--issues',
        issuesPath,
        '--json',
        out,
        '--before',
        '2021-01-01T00:00:00Z',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    const early = JSON.parse(readFileSync(out, 'utf8')).kinds.find(
      (entry) => entry.kind === 'changeset-history',
    );
    assert.equal(early.documents, 3);
    assert.equal(early.passed, 2);
  });

  it('issue: the plain and marked bodies pass, the semicolon and leaky bodies fail', () => {
    const row = rowFor('issue');
    assert.equal(row.documents, 4);
    assert.equal(row.passed, 2);
    assert.equal(row.rules[0].rule, 'prose-voice/no-semicolons');
    assert.deepEqual(row.rules[0].examples, ['#2']);
  });

  it('issue: a ledger id fails in prose and passes inside the sync marker', () => {
    const ledgerRule = rowFor('issue').rules.find(
      (rule) => rule.rule === 'public-text/ledger-id',
    );
    assert.equal(ledgerRule.failures, 1);
    assert.deepEqual(ledgerRule.examples, ['#4']);
  });

  it('lists every mapped checker per kind, sorted, whether or not any failed', () => {
    const expected = {
      plan: ['plan-lint', 'prose-lint'],
      'changeset-disk': ['changeset-shape', 'prose-lint', 'public-text'],
      'changeset-history': ['changeset-shape', 'prose-lint', 'public-text'],
      issue: ['prose-lint', 'public-text'],
      findings: ['check-findings', 'prose-lint'],
    };
    assert.deepEqual(
      Object.fromEntries(result.kinds.map((row) => [row.kind, row.checkers])),
      expected,
    );
  });

  it('findings: the anchored block passes, the unanchored evidence fails', () => {
    const row = rowFor('findings');
    assert.equal(row.documents, 2);
    assert.equal(row.passed, 1);
    assert.deepEqual(
      row.rules.map((rule) => rule.rule),
      ['findings/evidence-unanchored'],
    );
  });

  it('prints the table and exits 2 without --repo', () => {
    const run = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /usage: node doc-conformance\.mjs/);
  });
});
