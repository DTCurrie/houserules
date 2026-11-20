import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const PARSER = fileURLToPath(
  new URL('../health-kit/gather/parse-usage-report.mjs', import.meta.url),
);

function projectSection(name, fenceLines) {
  return [
    `### ${name}`,
    '',
    `- **Path:** \`~/Github/${name}\``,
    '- **Kit version:** 0.4.1 (installed 2026-08-26T17:08:56.875Z)',
    '- **Report produced by CLI:** 0.15.0 (temporary install)',
    '',
    '```text',
    '',
    `=== houserules report — ~/Github/${name} ===`,
    '',
    ...fenceLines,
    '```',
    '',
  ].join('\n');
}

function document(name, fenceLines) {
  return [
    '# houserules usage report: 2026-11-19',
    '',
    '## Summary',
    '',
    '| Project | Kit version (manifest) | Installed at | Report CLI | Sessions | Turns | Modules |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${name} | 0.4.1 | 2026-08-26 | 0.15.0 (temporary install) | 0 | 0 | 31 |`,
    '',
    '## Per-project reports',
    '',
    projectSection(name, fenceLines),
  ].join('\n');
}

function run(text) {
  const dir = mkdtempSync(join(tmpdir(), 'parse-usage-'));
  const doc = join(dir, 'doc.md');
  const out = join(dir, 'out.json');
  writeFileSync(doc, text);
  const result = spawnSync(process.execPath, [PARSER, doc, out], {
    encoding: 'utf8',
  });
  return { ...result, out };
}

describe('parse-usage-report, empty projects', () => {
  for (const { label, line } of [
    {
      label: 'No .jsonl transcripts in',
      line: 'No .jsonl transcripts in ~/.claude/projects/-Users-<user>-Github-widgets.',
    },
    {
      label: 'No transcripts found (looked in',
      line: 'No transcripts found (looked in ~/.claude/projects/-Users-<user>-Github-widgets).',
    },
  ]) {
    it(`reads "${label}" as an empty render`, () => {
      const result = run(document('widgets', [line]));

      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(readFileSync(result.out, 'utf8'));
      assert.equal(parsed.projects.length, 1);
      assert.equal(parsed.projects[0].name, 'widgets');
      assert.equal(parsed.projects[0].render, 'empty');
      assert.equal(parsed.projects[0].sessions.length, 0);
      assert.equal(parsed.projects[0].totals, null);
    });
  }

  it('still exits 1 naming the project when the fence has neither empty line nor a session line', () => {
    const result = run(document('widgets', ['Some other message.']));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /widgets: no "N session\(s\):" line/);
  });
});

const MACHINE_LINES = [
  '## Machine context',
  '',
  '- **Claude Code:** 2.1.328 (Claude Code)',
  '- **Node:** v24.16.0',
  '- **OS:** Darwin 25.6.0',
  '- **cleanupPeriodDays:** 365',
  '- **disableAllHooks:** unset',
  '- **outputStyle:** unset',
  '- **Enabled plugins:** none',
  '- **User skills:** retro, synced',
  '- **User agents:** none',
  '- **User CLAUDE.md:** 0 lines',
  '- **houserules on PATH:** none',
  '',
];

const SESSION_LINES = [
  '  f6342d7c  turns 32  in 257  out 7,308  cache_read 1,336,319  cache_write 58,291  tools 62  weighted-in 250,471  wall 1m',
  '            main weighted-in 250,471 out 7,308 | subagents weighted-in 0 out 0',
  '            claude-haiku-4-5-20251001: weighted-in 250,471 out 7,308',
];

const TOTALS_LINES = [
  '-- totals --',
  '  turns 32 | fresh input 257 | output 7,308',
  '  cache_read 1,336,319 | cache_write 58,291 | tool_results 62',
  '  cache-read share of input: 96% (cheap tier — the higher the better)',
  '  cache_write split: 1-hour 2,201,787 | 5-minute 1,507,828',
  '  cost-weighted input-equivalent: 250,471 (cache_read ×0.1, 5-minute cache_write ×1.25, 1-hour cache_write ×2)',
  '  list price: $369.36 (fresh $0.15, cache read $102.02, cache write $169.15, output $98.03)',
  '  not priced, no list price for: claude-haiku-4-5-20251001 (2% of weighted input), <synthetic> (0% of weighted input)',
  '  models: claude-haiku-4-5-20251001 | sidechain turns: 28%',
  '',
];

function fullDocument({
  name = 'widgets',
  reportCli = '- **Report produced by CLI:** 0.15.0 (temporary install)',
  range = true,
  extraFence = [],
  extraSections = [],
}) {
  return [
    '# houserules usage report: 2026-11-19',
    '',
    ...MACHINE_LINES,
    '## Summary',
    '',
    '| Project | Kit version (manifest) | Installed at | Report CLI | Sessions | Turns | Modules |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${name} | 0.14.0 | 2026-11-19 | 0.15.0 (temporary install) | 1 | 32 | 3 |`,
    '',
    ...extraSections,
    '## Per-project reports',
    '',
    `### ${name}`,
    '',
    `- **Path:** \`~/Projects/${name}\``,
    '- **Kit version:** 0.14.0 (installed 2026-11-19T16:07:36.950Z)',
    ...(reportCli ? [reportCli] : []),
    '',
    '```text',
    '',
    `=== houserules report — ~/Projects/${name} ===`,
    '',
    ...(range ? ['sessions: 1, from 2026-11-19 to 2026-11-19'] : []),
    '1 session(s):',
    ...SESSION_LINES,
    '',
    ...TOTALS_LINES,
    ...extraFence,
    '```',
    '',
  ].join('\n');
}

function parse(text) {
  const result = run(text);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(result.out, 'utf8'));
}

describe('parse-usage-report, sections the parser once dropped', () => {
  it('reads the Machine context bullets', () => {
    const parsed = parse(fullDocument({}));

    assert.deepEqual(parsed.machine, {
      claudeCode: '2.1.328 (Claude Code)',
      node: 'v24.16.0',
      os: 'Darwin 25.6.0',
      cleanupPeriodDays: '365',
      disableAllHooks: 'unset',
      outputStyle: 'unset',
      enabledPlugins: 'none',
      userSkills: 'retro, synced',
      userAgents: 'none',
      userClaudeMd: '0 lines',
      houseRulesOnPath: 'none',
    });
  });

  it('reads Install health per project, exit code and doctor lines included', () => {
    const parsed = parse(
      fullDocument({
        extraSections: [
          '## Install health',
          '',
          '**widgets:** `doctor` from temporary CLI 0.15.0, exit 2.',
          '',
          '```text',
          '✗ ERROR  houserules.config.json: version Invalid input: expected 2',
          '✗ ERROR  houserules.config.json: packageManager is required',
          '',
          '2 error(s), 0 warning(s).',
          '```',
          '',
        ],
      }),
    );

    assert.deepEqual(parsed.projects[0].installHealth, {
      cliSource: 'temporary',
      cliVersion: '0.15.0',
      exit: 2,
      lines: [
        '✗ ERROR  houserules.config.json: version Invalid input: expected 2',
        '✗ ERROR  houserules.config.json: packageManager is required',
        '2 error(s), 0 warning(s).',
      ],
    });
  });

  it('reads Guard reasons rows, and an empty list for a project that has none', () => {
    const parsed = parse(
      fullDocument({
        extraSections: [
          '## Guard reasons',
          '',
          '**widgets:**',
          '',
          '```text',
          '  guard            reason                                                                          blocks',
          '  ---------------  ------------------------------------------------------------------------------  ------',
          "  PreToolUse:Bash  git commit is the user's to run. Describe what's staged and stop.               3     ",
          "  PreToolUse:Bash  Opening PRs/issues is the user's call. Describe what's ready and stop.          1     ",
          '```',
          '',
          '**token-probe:**',
          '',
          '```text',
          'none',
          '```',
          '',
        ],
      }),
    );

    assert.deepEqual(parsed.projects[0].guardReasons, [
      {
        guard: 'PreToolUse:Bash',
        reason:
          "git commit is the user's to run. Describe what's staged and stop.",
        blocks: 3,
      },
      {
        guard: 'PreToolUse:Bash',
        reason:
          "Opening PRs/issues is the user's call. Describe what's ready and stop.",
        blocks: 1,
      },
    ]);
  });

  it('reads a fenced "none" under Guard reasons as no rows', () => {
    const parsed = parse(
      fullDocument({
        extraSections: [
          '## Guard reasons',
          '',
          '**widgets:**',
          '',
          '```text',
          'none',
          '```',
          '',
        ],
      }),
    );

    assert.deepEqual(parsed.projects[0].guardReasons, []);
  });

  it('reads the list price and every not-priced model', () => {
    const parsed = parse(fullDocument({}));

    assert.deepEqual(parsed.projects[0].totals.listPrice, {
      total: 369.36,
      fresh: 0.15,
      cacheRead: 102.02,
      cacheWrite: 169.15,
      output: 98.03,
    });
    assert.deepEqual(parsed.projects[0].totals.notPriced, [
      { model: 'claude-haiku-4-5-20251001', weightedPct: 2 },
      { model: '<synthetic>', weightedPct: 0 },
    ]);
  });

  it('reads artifact episode rows', () => {
    const parsed = parse(
      fullDocument({
        extraFence: [
          '',
          '-- artifact episodes --',
          '  session   calls  comments  publishes  requests  wall       output  weighted-in  share of session  model           ',
          '  --------  -----  --------  ---------  --------  ---------  ------  -----------  ----------------  ----------------',
          '  a9c0c7d4  13     0         10         44        113.1 min  94,092  1,241,760    3.7%              claude-fable-5-1',
        ],
      }),
    );

    assert.deepEqual(parsed.projects[0].artifactEpisodes, {
      none: false,
      rows: [
        {
          session: 'a9c0c7d4',
          calls: 13,
          comments: 0,
          publishes: 10,
          requests: 44,
          wall: '113.1 min',
          output: 94092,
          weightedIn: 1241760,
          sharePct: 3.7,
          model: 'claude-fable-5-1',
        },
      ],
    });
  });

  it('reads an artifact block with no calls as none', () => {
    const parsed = parse(
      fullDocument({
        extraFence: [
          '',
          '-- artifact episodes --',
          '  No Artifact calls were recorded.',
        ],
      }),
    );

    assert.deepEqual(parsed.projects[0].artifactEpisodes, {
      none: true,
      rows: [],
    });
  });

  it('leaves the new fields empty when a document lacks the sections', () => {
    const parsed = parse(
      fullDocument({}).replace(MACHINE_LINES.join('\n'), ''),
    );

    assert.equal(parsed.machine, null);
    assert.equal(parsed.projects[0].installHealth, null);
    assert.deepEqual(parsed.projects[0].guardReasons, []);
    assert.equal(parsed.projects[0].artifactEpisodes, null);
  });
});

describe('parse-usage-report, render label', () => {
  it('labels a project with a range line "current"', () => {
    assert.equal(parse(fullDocument({})).projects[0].render, 'current');
  });

  it('labels a range-less project with the CLI version it states', () => {
    const parsed = parse(
      fullDocument({
        range: false,
        reportCli: '- **Report produced by CLI:** 0.12.1 (temporary install)',
      }),
    );

    assert.equal(parsed.projects[0].render, '0.12.1');
  });

  it('labels a range-less project that states no version "unknown"', () => {
    const parsed = parse(fullDocument({ range: false, reportCli: null }));

    assert.equal(parsed.projects[0].render, 'unknown');
  });
});
