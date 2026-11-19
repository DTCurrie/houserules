import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { HouseError } from '../../../house-error.js';
import { renderArtifactEpisodes } from '../artifact-episodes.js';
import { renderFriction } from '../friction.js';
import { renderHookHealth } from '../hook-health.js';
import { renderTokenUsage } from '../token-usage.js';
import {
  buildReportDocument,
  deserializeTokenUsage,
  type ReportDocument,
} from '../report-document.js';
import {
  readImportFiles,
  redactDocument,
  writeExportFile,
} from '../report-export.js';
import {
  emptyCorpus,
  ingestTranscript,
  type FileUsage,
} from '../transcript-events.js';

const SECRET_PATH = '/Users/someone/work/secret.ts';
const SECRET_DIR =
  '/private/tmp/claude-501/-Users-someone-work/abc123/scratchpad';

function bashUse(id: string, command: string): unknown {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
  };
}

function hookFire(
  toolUseID: string,
  exitCode: number,
  stderr: string,
): unknown {
  return {
    type: 'attachment',
    attachment: {
      hookName: 'PreToolUse:Bash',
      exitCode,
      stderr,
      toolUseID,
    },
  };
}

function denial(toolUseId: string): unknown {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: "The user doesn't want to proceed with this tool use",
        },
      ],
    },
  };
}

function buildFixture(): ReportDocument {
  const corpus = emptyCorpus(['slug']);
  const records = [
    bashUse('t1', 'git push origin main'),
    bashUse('t2', 'git push origin main'),
    hookFire('t1', 2, 'blocked by policy'),
    hookFire(
      't1',
      1,
      `Error: Cannot find module '/Users/someone/work/hook-lib.mjs'`,
    ),
    hookFire('t1', 1, `throw err at ${SECRET_PATH}`),
    bashUse('t3', `rm -rf ${SECRET_PATH}`),
    denial('t3'),
    bashUse('t4', `S=${SECRET_DIR}; node ${SECRET_DIR}/probe.mjs`),
    denial('t4'),
    bashUse('t5', '../../packages/ui/node_modules/.bin/prettier --write src'),
    denial('t5'),
    bashUse('t6', '( pnpm run build && echo ok )'),
    denial('t6'),
    bashUse('t7', `D="${SECRET_PATH}`),
    denial('t7'),
  ];
  ingestTranscript(
    corpus,
    'sess-abcdef12.jsonl',
    records.map((record) => JSON.stringify(record)).join('\n'),
  );
  const root = mkdtempSync(join(tmpdir(), 'report-export-root-'));
  return buildReportDocument(corpus, root, {
    label: 'work',
    cliVersion: '0.7.0',
    now: new Date('2026-10-16T00:00:00Z'),
  });
}

describe('redactDocument', () => {
  let original: ReportDocument;
  let snapshot: string;
  let redacted: ReportDocument;

  beforeAll(() => {
    original = buildFixture();
    snapshot = JSON.stringify(original);
    redacted = redactDocument(original);
  });

  it('seeds a guard block, a denial, a retry run, and a crash signature in the fixture', () => {
    expect(original.guard.map((block) => block.blockedCommand)).toEqual([
      'git push origin main',
    ]);
    expect(original.friction.denials[0]?.command).toBe(`rm -rf ${SECRET_PATH}`);
    expect(original.friction.retryRuns[0]?.command).toBe(
      'git push origin main',
    );
    expect(original.hooks.crashSignatures.length).toBeGreaterThan(0);
  });

  it('removes paths, file names, and command arguments', () => {
    const text = JSON.stringify(redacted);

    expect(text).not.toContain('/Users/');
    expect(text).not.toContain('/private/tmp/');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('origin main');
    expect(text).not.toContain('node_modules');
  });

  it('keeps the git subcommand as the command family', () => {
    expect(redacted.guard).toEqual([
      { session: 'sess-abc', blockedCommand: 'git push' },
    ]);
    expect(redacted.friction.retryRuns[0]?.command).toBe('git push');
  });

  it('reduces a non-git command to its first token', () => {
    expect(redacted.friction.denials[0]).toEqual({
      tool: 'Bash',
      command: 'rm',
    });
  });

  it('skips a leading variable assignment and keeps the executable that follows it', () => {
    expect(redacted.friction.denials[1]?.command).toBe('node');
  });

  it('reduces a path-shaped executable to its basename', () => {
    expect(redacted.friction.denials[2]?.command).toBe('prettier');
  });

  it('skips a lone subshell opener before the executable', () => {
    expect(redacted.friction.denials[3]?.command).toBe('pnpm');
  });

  it('names a command that is only an assignment without keeping its value', () => {
    expect(redacted.friction.denials[4]?.command).toBe('(assignment)');
  });

  it('keeps a missing-module signature as its basename and redacts any other', () => {
    expect(redacted.hooks.crashSignatures).toEqual([
      { signature: "Cannot find module 'hook-lib.mjs'", count: 1 },
      { signature: 'stderr line (redacted)', count: 1 },
    ]);
  });

  it('leaves hook rows, bulk, tokens, and meta unchanged', () => {
    expect(redacted.hooks.rows).toEqual(original.hooks.rows);
    expect(redacted.friction.bulkByTool).toEqual(original.friction.bulkByTool);
    expect(redacted.tokens).toEqual(original.tokens);
    expect(redacted.meta).toEqual(original.meta);
  });

  it('does not mutate its input', () => {
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe('writeExportFile and readImportFiles', () => {
  it('round-trips a document through a nested path', () => {
    const document = buildFixture();
    const path = join(
      mkdtempSync(join(tmpdir(), 'report-export-')),
      'a',
      'b',
      'out.json',
    );

    writeExportFile(path, document);

    expect(readImportFiles([path])).toEqual([
      JSON.parse(JSON.stringify(document)),
    ]);
  });

  it('throws a HouseError naming the path when the file is not a report document', () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-export-'));
    const path = join(dir, 'nope.json');
    writeFileSync(path, '{"nope":1}');

    expect(() => readImportFiles([path])).toThrow(HouseError);
    expect(() => readImportFiles([path])).toThrow(path);
  });

  it('throws a HouseError naming the path when the file is not JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-export-'));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'broken.json');
    writeFileSync(path, 'not json');

    expect(() => readImportFiles([path])).toThrow(path);
  });

  it('throws a HouseError naming the path when the file is missing', () => {
    const path = join(tmpdir(), 'report-export-missing', 'gone.json');

    expect(() => readImportFiles([path])).toThrow(HouseError);
    expect(() => readImportFiles([path])).toThrow(path);
  });
});

describe('token usage serialization', () => {
  it('carries timestamps, origin split, and per-model slices through JSON', () => {
    const corpus = emptyCorpus(['slug']);
    const file: FileUsage = {
      file: 'sess-1.jsonl',
      turns: 3,
      input: 30,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
      toolResults: 0,
      models: new Set(['sonnet', 'opus']),
      sidechainTurns: 1,
      skippedLines: 0,
      excludedPlaceholderRecords: 0,
      firstTs: 1_760_000_000_000,
      lastTs: 1_760_000_900_000,
      byOrigin: {
        main: { turns: 2, input: 20, output: 4, cacheRead: 1, cacheWrite: 2 },
        subagent: {
          turns: 1,
          input: 10,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
        },
      },
      byModel: new Map([
        [
          'sonnet',
          { turns: 1, input: 10, output: 2, cacheRead: 3, cacheWrite: 4 },
        ],
        [
          'opus',
          { turns: 2, input: 20, output: 4, cacheRead: 1, cacheWrite: 2 },
        ],
      ]),
    };
    corpus.files.push(file);
    const root = mkdtempSync(join(tmpdir(), 'report-export-root-'));
    const document = buildReportDocument(corpus, root, {
      label: 'work',
      cliVersion: '0.7.0',
    });

    const parsed = JSON.parse(JSON.stringify(document)) as ReportDocument;
    const [restored] = deserializeTokenUsage(parsed.tokens).files;

    expect(restored?.firstTs).toBe(1_760_000_000_000);
    expect(restored?.lastTs).toBe(1_760_000_900_000);
    expect(restored?.byOrigin).toEqual({
      main: { turns: 2, input: 20, output: 4, cacheRead: 1, cacheWrite: 2 },
      subagent: { turns: 1, input: 10, output: 2, cacheRead: 3, cacheWrite: 4 },
    });
    expect(restored?.byModel).toEqual(
      new Map([
        [
          'opus',
          { turns: 2, input: 20, output: 4, cacheRead: 1, cacheWrite: 2 },
        ],
        [
          'sonnet',
          { turns: 1, input: 10, output: 2, cacheRead: 3, cacheWrite: 4 },
        ],
      ]),
    );
    expect(Object.keys(parsed.tokens.files[0]?.byModel ?? {})).toEqual([
      'opus',
      'sonnet',
    ]);
  });
});

const USERNAME = 'alice';

function withNewFields(document: ReportDocument): ReportDocument {
  const slice = { turns: 1, input: 1, output: 1, cacheRead: 1, cacheWrite: 4 };
  return {
    ...document,
    hooks: {
      ...document.hooks,
      stopHooks: [
        {
          hook: 'lint-format-fix.mjs',
          runs: 3,
          p50: 10,
          p95: 20,
          max: 30,
          timeouts: 0,
        },
        {
          hook: `/Users/${USERNAME}/work/bin/stop-check --token ${USERNAME}`,
          runs: 2,
          p50: 5,
          p95: 6,
          max: 7,
          timeouts: 1,
        },
        {
          hook: `node /Users/${USERNAME}/work/hooks/custom.mjs`,
          runs: 1,
          p50: 1,
          p95: 1,
          max: 1,
          timeouts: 0,
        },
        {
          hook: '(per Stop total)',
          runs: 3,
          p50: 12,
          p95: 22,
          max: 32,
          timeouts: 1,
        },
      ],
    },
    friction: {
      ...document.friction,
      toolResultSizes: {
        capBytes: 16384,
        read: { results: 4, bytes: 90000, overCap: 2 },
        bash: { results: 5, bytes: 1000, overCap: 0 },
        isTrimInstalled: false,
      },
    },
    artifacts: {
      episodes: [
        {
          session: 'abcdef12',
          artifactCalls: 3,
          commentCalls: 1,
          publishes: 2,
          requests: 9,
          output: 500,
          weightedInput: 4000,
          sessionWeightedInput: 8000,
          model: 'claude-sonnet-5-5',
          wallMs: 120000,
        },
      ],
    },
    tokens: {
      ...document.tokens,
      totals: { ...document.tokens.totals, cacheWrite1h: 3 },
      files: [
        {
          ...(document.tokens
            .files[0] as ReportDocument['tokens']['files'][number]),
          cacheWrite1h: 3,
          byOrigin: {
            main: { ...slice, cacheWrite1h: 3 },
            subagent: { ...slice, cacheWrite1h: 0 },
          },
          byModel: { 'claude-sonnet-5-5': { ...slice, cacheWrite1h: 3 } },
        },
      ],
    },
  };
}

describe('redactDocument on the fields added after the first exports', () => {
  const original = withNewFields(buildFixture());
  const redacted = redactDocument(original);

  it('holds no path and no username anywhere in the export', () => {
    const text = JSON.stringify(redacted);

    expect(text).not.toContain('/Users/');
    expect(text).not.toContain(USERNAME);
    expect(text).not.toContain('--token');
  });

  it('keeps a bare script name and the per-Stop total, and reduces any other Stop hook name to its command family', () => {
    expect(redacted.hooks.stopHooks?.map((row) => row.hook)).toEqual([
      'lint-format-fix.mjs',
      'stop-check',
      'node',
      '(per Stop total)',
    ]);
  });

  it('keeps every count on a Stop row', () => {
    expect(redacted.hooks.stopHooks?.[1]).toEqual({
      hook: 'stop-check',
      runs: 2,
      p50: 5,
      p95: 6,
      max: 7,
      timeouts: 1,
    });
  });

  it('keeps the result sizes, the artifact episodes, and the 1-hour cache writes untouched', () => {
    expect(redacted.friction.toolResultSizes).toEqual(
      original.friction.toolResultSizes,
    );
    expect(redacted.artifacts).toEqual(original.artifacts);
    expect(redacted.tokens).toEqual(original.tokens);
    expect(redacted.tokens.totals.cacheWrite1h).toBe(3);
  });
});

describe('a document exported before the new readouts', () => {
  function preReadoutDocument(): ReportDocument {
    const stripped = JSON.parse(
      JSON.stringify(withNewFields(buildFixture())),
      (key, value: unknown) =>
        key === 'cacheWrite1h' ||
        key === 'stopHooks' ||
        key === 'toolResultSizes' ||
        key === 'artifacts'
          ? undefined
          : value,
    ) as ReportDocument;
    return stripped;
  }

  it('imports through readImportFiles', () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'report-export-old-')),
      'old.json',
    );
    writeExportFile(path, preReadoutDocument());

    const [imported] = readImportFiles([path]);

    expect(imported?.meta.label).toBe('work');
    expect(imported?.hooks.stopHooks).toBeUndefined();
  });

  it('renders with no Stop table, no result-size line, and no artifact section', () => {
    const document = preReadoutDocument();

    const hooks = renderHookHealth(document.hooks).join('\n');
    const friction = renderFriction(document.friction).join('\n');

    expect(hooks).not.toContain('Stop hooks');
    expect(friction).not.toContain('result size');
    expect(renderArtifactEpisodes(document.artifacts)).toEqual([]);
  });

  it('prints the cache-write split as not recorded, not as zero', () => {
    const document = preReadoutDocument();

    const tokens = renderTokenUsage(
      deserializeTokenUsage(document.tokens),
    ).join('\n');

    expect(tokens).toContain(
      'cache_write split: 1-hour vs 5-minute not recorded in this document',
    );
    expect(tokens).not.toContain('cache_write split: 1-hour 0');
  });
});
