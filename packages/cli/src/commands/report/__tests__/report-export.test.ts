import { renderKitVersions } from '../kit-versions.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const PAYLOAD_SCRIPTS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'payload-dist',
  'scripts',
);

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

describe('fix config in the export', () => {
  function emptyDocument(root: string): ReportDocument {
    return buildReportDocument(emptyCorpus(['slug']), root, {
      label: 'work',
      cliVersion: '0.7.0',
    });
  }

  it('exports counts and booleans, never a command name', () => {
    const root = mkdtempSync(join(tmpdir(), 'report-export-fix-'));
    mkdirSync(join(root, '.claude'));
    writeFileSync(
      join(root, '.claude', 'houserules.config.json'),
      JSON.stringify({
        version: 2,
        packageManager: 'pnpm',
        fix: {
          runner: 'pnpm',
          filterFlag: '',
          runScriptPrefix: ['run'],
          commands: ['zzformat-secret', 'zzlint-secret'],
        },
        targets: [],
      }),
    );

    const exported = redactDocument(emptyDocument(root));

    expect(exported.fix).toEqual({
      runsAtRoot: true,
      commandCount: 2,
      hasFilterFlag: false,
      passPaths: false,
      targetsWithFixCommands: 0,
    });
    const text = JSON.stringify(exported);
    expect(text).not.toContain('zzformat-secret');
    expect(text).not.toContain('zzlint-secret');
  });

  it('omits the block with no config, and an older export without it still imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'report-export-nofix-'));
    const document = emptyDocument(root);
    expect(document.fix).toBeUndefined();

    const path = join(root, 'old.json');
    writeExportFile(path, document);
    const [imported] = readImportFiles([path]);

    expect(imported?.fix).toBeUndefined();
  });
});

describe('weighted input per session', () => {
  // 100 + (40 - 20) * 1.25 + 20 * 2 + 1000 * 0.1 = 265
  function weightedDocument(): ReportDocument {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'sess-weighted.jsonl',
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          role: 'assistant',
          model: 'opus',
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 40,
            cache_creation: { ephemeral_1h_input_tokens: 20 },
          },
        },
      }),
    );
    return buildReportDocument(
      corpus,
      mkdtempSync(join(tmpdir(), 'report-export-weighted-')),
      { label: 'work', cliVersion: '0.7.0' },
    );
  }

  it('round-trips the field through an export file', () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'report-export-weighted-file-')),
      'w.json',
    );
    writeExportFile(path, redactDocument(weightedDocument()));

    const [imported] = readImportFiles([path]);

    expect(imported?.tokens.files[0]?.weightedInput).toBe(265);
  });
});

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

  describe('guard reasons', () => {
    function reasonAfterRedaction(reason: string | undefined): unknown {
      const out = redactDocument({
        ...original,
        guard: [
          {
            session: 's',
            blockedCommand: 'x',
            ...(reason === undefined ? {} : { reason }),
          },
        ],
      });
      return out.guard[0]?.reason;
    }
    const readTail =
      ". Don't read it whole — grep for what you need (`grep -n '<pattern>' PATH`) then Read with offset+limit, or re-run this Read with an explicit limit if you truly need a window.";

    it('masks the path of a read-guard reason, both occurrences', () => {
      const raw = `houserules read guard: packages/secret/dist/out.js is large (900 KB > 256 KB)${readTail.replace('PATH', 'packages/secret/dist/out.js')}`;

      expect(reasonAfterRedaction(raw)).toBe(
        `houserules read guard: <path> is large (900 KB > 256 KB)${readTail.replace('PATH', '<path>')}`,
      );
    });

    it('masks the matched glob of a read-guard reason', () => {
      const raw = `houserules read guard: a/b.lock matches a generated/denylisted pattern (*.lock)${readTail.replace('PATH', 'a/b.lock')}`;

      expect(reasonAfterRedaction(raw)).toBe(
        `houserules read guard: <path> matches a generated/denylisted pattern (<pattern>)${readTail.replace('PATH', '<path>')}`,
      );
    });

    it('masks the ledger subcommand of a write-gate reason', () => {
      const raw =
        'Blocked by houserules subagent write gate: a subagent may not run ledger command `backlog-add.mjs --title private`. Describe the issue and let the caller act on it.';

      expect(reasonAfterRedaction(raw)).toBe(
        'Blocked by houserules subagent write gate: a subagent may not run ledger command `<subcommand>`. Describe the issue and let the caller act on it.',
      );
    });

    it('passes a fixed git guard message through verbatim', () => {
      expect(reasonAfterRedaction("git push is the user's to run.")).toBe(
        "git push is the user's to run.",
      );
    });

    it('replaces an unknown reason with a placeholder', () => {
      expect(reasonAfterRedaction(`see ${SECRET_PATH}`)).toBe(
        '(reason redacted)',
      );
    });

    it('leaves an absent reason absent', () => {
      expect(reasonAfterRedaction(undefined)).toBeUndefined();
    });
  });

  describe('against the real guard output', () => {
    const CONFIG = {
      version: 2,
      guard: {
        custom: [{ pattern: '\\bsecret-tool\\b', message: 'ask Dana' }],
      },
      readGuard: { enabled: true, maxBytes: 1024, denyGlobs: ['*.lock'] },
      targets: [],
    };

    function guardRepo(config: unknown): string {
      const root = mkdtempSync(join(tmpdir(), 'report-export-guard-'));
      spawnSync('git', ['init', '-q'], { cwd: root });
      mkdirSync(join(root, '.claude'));
      writeFileSync(
        join(root, '.claude/houserules.config.json'),
        JSON.stringify(config),
      );
      return root;
    }

    /** Runs a built guard and returns its first stderr line, the way a transcript records a reason. */
    function realReason(
      script: string,
      toolInput: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ): string {
      const root = guardRepo(CONFIG);
      writeFileSync(join(root, 'dep.lock'), 'x');
      writeFileSync(join(root, 'big.txt'), 'x'.repeat(3072));
      const run = spawnSync(process.execPath, [join(PAYLOAD_SCRIPTS, script)], {
        cwd: root,
        input: JSON.stringify({ tool_input: toolInput, ...extra }),
        encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(2);
      const first = run.stderr.split('\n').find((line) => line.trim()) ?? '';
      const prefix = 'Blocked by houserules guard: ';
      return first.startsWith(prefix) ? first.slice(prefix.length) : first;
    }

    function redacted(reason: string): string | undefined {
      return redactDocument({
        ...original,
        guard: [{ session: 's', blockedCommand: 'x', reason }],
      }).guard[0]?.reason;
    }

    const bash = (command: string) => realReason('guard-bash.mjs', { command });
    const subagentBash = (command: string) =>
      realReason('guard-bash.mjs', { command }, { agent_id: 'agent-1' });

    it.each([
      ['git commit', 'git commit -m x'],
      ['git push', 'git push origin main'],
      ['git stash', 'git stash'],
      ['git discard', 'git checkout -- src/a.ts'],
      ['PR create', 'gh pr create --fill'],
    ])('keeps the %s message verbatim', (_name, command) => {
      const reason = bash(command);

      expect(reason).not.toBe('');
      expect(redacted(reason)).toBe(reason);
    });

    it.each([
      ['changeset', 'node .claude/scripts/changeset-write.mjs --bump patch'],
      ['direct ledger edit', 'sed -i s/a/b/ ledgers/backlog.jsonl'],
    ])(
      'keeps the subagent write gate %s message verbatim',
      (_name, command) => {
        const reason = subagentBash(command);

        expect(reason).toMatch(/^Blocked by houserules subagent write gate/);
        expect(redacted(reason)).toBe(reason);
      },
    );

    it('masks only the subcommand of the real ledger gate message', () => {
      const reason = subagentBash(
        'node .claude/scripts/backlog-log.mjs add API area "title"',
      );

      expect(redacted(reason)).toBe(
        'Blocked by houserules subagent write gate: a subagent may not run ledger command `<subcommand>`. Describe the issue and let the caller act on it.',
      );
    });

    it('masks only the path of the real read guard size message', () => {
      const reason = realReason('guard-read.mjs', { file_path: 'big.txt' });

      expect(redacted(reason)).toBe(
        "houserules read guard: <path> is large (3 KB > 1 KB). Don't read it whole — grep for what you need (`grep -n '<pattern>' <path>`) then Read with offset+limit, or re-run this Read with an explicit limit if you truly need a window.",
      );
    });

    it('masks the path and glob of the real read guard denylist message', () => {
      const reason = realReason('guard-read.mjs', { file_path: 'dep.lock' });

      expect(redacted(reason)).toBe(
        "houserules read guard: <path> matches a generated/denylisted pattern (<pattern>). Don't read it whole — grep for what you need (`grep -n '<pattern>' <path>`) then Read with offset+limit, or re-run this Read with an explicit limit if you truly need a window.",
      );
    });

    it('replaces the message a user wrote for a custom rule', () => {
      const root = guardRepo({
        version: 2,
        guard: {
          custom: [{ pattern: '\\bsecret-tool\\b', message: 'ask Dana' }],
        },
        targets: [],
      });
      const run = spawnSync(
        process.execPath,
        [join(PAYLOAD_SCRIPTS, 'guard-bash.mjs')],
        {
          cwd: root,
          input: JSON.stringify({ tool_input: { command: 'secret-tool x' } }),
          encoding: 'utf8',
        },
      );

      expect(run.stderr).toBe('Blocked by houserules guard: ask Dana\n');
      expect(redacted('ask Dana')).toBe('(reason redacted)');
    });
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
      {
        session: 'sess-abc',
        blockedCommand: 'git push',
        guard: 'PreToolUse:Bash',
        reason: '(reason redacted)',
      },
    ]);
    expect(redacted.friction.retryRuns[0]?.command).toBe('git push');
  });

  it('redacts a guard reason and reduces a raw-command guard name to its family', () => {
    const document = buildFixture();
    document.guard = [
      {
        session: 'sess-abc',
        blockedCommand: 'git push origin main',
        guard: 'node /Users/someone/secret/guard.mjs --flag',
        reason: 'refused to touch /Users/someone/secret/file.txt',
      },
      {
        session: 'sess-abc',
        blockedCommand: 'ls',
        guard: 'PreToolUse:Bash',
        reason: 'x',
      },
    ];

    const exported = redactDocument(document);

    expect(exported.guard).toEqual([
      {
        session: 'sess-abc',
        blockedCommand: 'git push',
        guard: 'node',
        reason: '(reason redacted)',
      },
      {
        session: 'sess-abc',
        blockedCommand: 'ls',
        guard: 'PreToolUse:Bash',
        reason: '(reason redacted)',
      },
    ]);
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
          slowRuns: 2,
          timedOutRuns: [
            { date: '2026-11-18T10:30:00.000Z', session: 'abc.jsonl' },
          ],
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
      slowRuns: 2,
      timedOutRuns: [
        { date: '2026-11-18T10:30:00.000Z', session: 'abc.jsonl' },
      ],
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
        key === 'weightedInput' ||
        key === 'toolResultSizes' ||
        key === 'artifacts' ||
        key === 'kitVersions'
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

  it('imports a Stop row with no timed-out list and a session with no weighted input', () => {
    const document = preReadoutDocument();
    document.hooks.stopHooks = [
      { hook: 'a.mjs', runs: 1, p50: 1, p95: 1, max: 1, timeouts: 0 },
    ];
    const path = join(
      mkdtempSync(join(tmpdir(), 'report-export-old-')),
      'older.json',
    );
    writeExportFile(path, document);

    const [imported] = readImportFiles([path]);

    expect(imported?.hooks.stopHooks?.[0]?.timedOutRuns).toBeUndefined();
    expect(imported?.tokens.files[0]?.weightedInput).toBeUndefined();
    expect(renderHookHealth(imported!.hooks).join('\n')).toContain('a.mjs');
  });

  it('renders with no Stop table, no result-size line, and no artifact section', () => {
    const document = preReadoutDocument();

    const hooks = renderHookHealth(document.hooks).join('\n');
    const friction = renderFriction(document.friction).join('\n');

    expect(hooks).not.toContain('Stop hooks');
    expect(friction).not.toContain('result size');
    expect(renderArtifactEpisodes(document.artifacts)).toEqual([]);
    expect(document.kitVersions).toBeUndefined();
    expect(renderKitVersions(document.kitVersions)).toEqual([]);
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

describe('bash wall time in the export', () => {
  function bashWallDocument(): ReportDocument {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'sess-wall.jsonl',
      [
        {
          type: 'assistant',
          timestamp: '2026-10-01T10:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'w1',
                name: 'Bash',
                input: { command: `FOO=1 git push ${SECRET_PATH}` },
              },
            ],
          },
        },
        {
          type: 'user',
          timestamp: '2026-10-01T10:00:03.000Z',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'w1', content: '' }],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
    );
    return buildReportDocument(
      corpus,
      mkdtempSync(join(tmpdir(), 'report-export-wall-')),
      { label: 'work', cliVersion: '0.7.0' },
    );
  }

  it('reduces each slowest command to its family and keeps the seconds', () => {
    const document = bashWallDocument();
    expect(document.bashWall?.slowest[0]?.command).toContain(SECRET_PATH);

    const exported = redactDocument(document);

    expect(exported.bashWall?.slowest[0]?.command).toBe('git push');
    expect(exported.bashWall?.slowest[0]?.seconds).toBe(3);
    expect(JSON.stringify(exported)).not.toContain(SECRET_PATH);
  });

  it('leaves bashWall absent on a document that never had it', () => {
    const { bashWall: _bashWall, ...older } = bashWallDocument();

    const exported = redactDocument(older as ReportDocument);

    expect('bashWall' in exported).toBe(false);
  });
});
