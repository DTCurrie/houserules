import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';

import { claudeProjectDir } from '@houserules/payload/entry-ledger';

import { useRepo } from '#test/repo';
import { runCli, runIn } from '#test/run';

const INPUT_TOKENS = 100;
const CACHE_CREATION_TOKENS = 200;
const CACHE_READ_TOKENS = 900;
const CACHE_CREATION_WEIGHT = 1.25;
const CACHE_READ_WEIGHT = 0.1;
const EXPECTED_WEIGHTED_TOTAL =
  INPUT_TOKENS +
  CACHE_CREATION_TOKENS * CACHE_CREATION_WEIGHT +
  CACHE_READ_TOKENS * CACHE_READ_WEIGHT;

describe('report', () => {
  let root: string;
  let cfgDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = useRepo('pnpm-monorepo');
    cfgDir = mkdtempSync(join(tmpdir(), 'kit-cfg-'));
    onTestFinished(() => rmSync(cfgDir, { recursive: true, force: true }));

    const top = runIn(root, 'git', ['rev-parse', '--show-toplevel']).trim();
    const projDir = join(cfgDir, 'projects', claudeProjectDir(top));
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'sess-abcdef12.jsonl'),
      [
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-05-01T00:00:00.000Z',
          message: {
            model: 'claude-opus-4-8',
            usage: {
              input_tokens: INPUT_TOKENS,
              output_tokens: 50,
              cache_read_input_tokens: CACHE_READ_TOKENS,
              cache_creation_input_tokens: CACHE_CREATION_TOKENS,
            },
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', content: 'ok' }],
          },
        }),
        '',
      ].join('\n'),
    );
    env = { ...process.env, CLAUDE_CONFIG_DIR: cfgDir };
  });

  it('aggregates transcript usage into a cost-weighted input-equivalent total', () => {
    const r = runCli(['report', root], { env });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/1 session/);
    expect(r.stdout).toMatch(/turns 1/);
    expect(r.stdout).toMatch(new RegExp(`cache_read ${CACHE_READ_TOKENS}`));
    expect(r.stdout).toMatch(/claude-opus-4-8/);
    expect(r.stdout).toMatch(/cost-weighted input-equivalent/);
    expect(r.stdout).toMatch(new RegExp(String(EXPECTED_WEIGHTED_TOTAL)));
  });

  it('reports cleanly, still exiting 0, on a repo with no transcripts', () => {
    const empty = useRepo('non-js');
    const r = runCli(['report', empty], { env });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No transcripts found/);
  });

  it('appends the metric family sections after the token tables', () => {
    const r = runCli(['report', root], { env });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/-- hook health --/);
    expect(r.stdout).toMatch(/no genuine blocks in this corpus/);
    expect(r.stdout).toMatch(/-- skills --/);
    expect(r.stdout).toMatch(/no skill fires in this corpus/);
    expect(r.stdout).toMatch(/outcomes:/);
    expect(r.stdout).toMatch(/-- friction --/);
  });

  it('folds a subagent transcript into its parent session row', () => {
    const top = runIn(root, 'git', ['rev-parse', '--show-toplevel']).trim();
    const subDir = join(
      cfgDir,
      'projects',
      claudeProjectDir(top),
      'sess-abcdef12',
      'subagents',
    );
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-deadbeef.jsonl'),
      [
        JSON.stringify({
          type: 'assistant',
          sessionId: 'sess-abcdef12',
          isSidechain: true,
          message: {
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 5, output_tokens: 9 },
            content: [
              {
                type: 'tool_use',
                id: 't1',
                name: 'Skill',
                input: { skill: 'tidy' },
              },
            ],
          },
        }),
        // No sessionId: must fall back to the parent session, never a new row.
        JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          message: {
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
        '',
      ].join('\n'),
    );

    const r = runCli(['report', root], { env });

    expect(r.status, r.stderr).toBe(0);
    // Folded, not counted as extra sessions.
    expect(r.stdout).toMatch(/1 session\(s\):/);
    // Base turn plus the two sidechain turns.
    expect(r.stdout).toMatch(/turns 3/);
    expect(r.stdout).toMatch(/sidechain turns: [1-9]\d?%/);
    expect(r.stdout).toMatch(/claude-haiku-4-5/);
    // A skill invoked only inside the subagent is now visible.
    expect(r.stdout).toMatch(/\btidy\b/);
  });

  it('merges a --slug transcript dir into the corpus', () => {
    const extraDir = join(cfgDir, 'projects', 'extra-history');
    mkdirSync(extraDir, { recursive: true });
    writeFileSync(
      join(extraDir, 'sess-99999999.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      })}\n`,
    );

    const r = runCli(['report', root, '--slug', 'extra-history'], { env });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/transcript dirs: .*extra-history/);
    expect(r.stdout).toMatch(/2 session\(s\):/);
    expect(r.stdout).toMatch(/sess-999/);
    expect(r.stdout).toMatch(/turns 2/);
  });

  it('prints the whole document under --json and nothing else', () => {
    const r = runCli(['report', root, '--json'], { env });

    expect(r.status, r.stderr).toBe(0);
    const document = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(document).sort()).toEqual([
      'friction',
      'guard',
      'hooks',
      'meta',
      'outcomes',
      'residentContext',
      'skills',
      'tokens',
    ]);
    expect(document.meta).toMatchObject({ sessions: 1, label: 'local' });
  });

  it('skips sessions before --since and keeps later ones', () => {
    const skipped = runCli(['report', root, '--since', '2026-06-01'], { env });
    expect(skipped.status, skipped.stderr).toBe(0);
    expect(skipped.stdout).toMatch(
      /\(1 session\(s\) before 2026-06-01 skipped\)/,
    );
    expect(skipped.stdout).not.toMatch(/sess-abc/);

    const kept = runCli(['report', root, '--since', '2026-04-01'], { env });
    expect(kept.status, kept.stderr).toBe(0);
    expect(kept.stdout).toMatch(/1 session\(s\):/);
    expect(kept.stdout).not.toMatch(/skipped\)/);
  });

  describe('corpus window', () => {
    const DAY_MS = 86_400_000;
    const WARNING = /cleanupPeriodDays, default 30/;

    function addSession(name: string, timestamp: string): void {
      const top = runIn(root, 'git', ['rev-parse', '--show-toplevel']).trim();
      writeFileSync(
        join(cfgDir, 'projects', claudeProjectDir(top), `${name}.jsonl`),
        `${JSON.stringify({
          type: 'assistant',
          timestamp,
          message: {
            model: 'claude-opus-4-8',
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        })}\n`,
      );
    }

    function replaceFirstSession(timestamp: string): void {
      const top = runIn(root, 'git', ['rev-parse', '--show-toplevel']).trim();
      rmSync(
        join(cfgDir, 'projects', claudeProjectDir(top), 'sess-abcdef12.jsonl'),
      );
      addSession('sess-abcdef12', timestamp);
    }

    it('prints the session count and the first and last session dates', () => {
      addSession('sess-22222222', '2026-05-03T12:00:00.000Z');

      const r = runCli(['report', root], { env });

      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('sessions: 2, from 2026-05-01 to 2026-05-03');
    });

    it('warns when --since predates the oldest transcript', () => {
      const r = runCli(['report', root, '--since', '2026-04-01'], { env });

      expect(r.stdout).toContain(
        '(warning: --since 2026-04-01 predates the oldest transcript, 2026-05-01.',
      );
      expect(r.stdout).toMatch(WARNING);
    });

    it('does not warn when --since falls after the oldest transcript', () => {
      addSession('sess-33333333', '2026-06-10T00:00:00.000Z');

      const r = runCli(['report', root, '--since', '2026-06-10'], { env });

      expect(r.stdout).not.toMatch(WARNING);
    });

    it('warns when the oldest transcript is 29 days old', () => {
      replaceFirstSession(new Date(Date.now() - 29 * DAY_MS).toISOString());

      const r = runCli(['report', root], { env });

      expect(r.stdout).toMatch(/\(warning: the oldest transcript is /);
      expect(r.stdout).toMatch(WARNING);
    });

    it('stays quiet when the oldest transcript is 10 days old', () => {
      replaceFirstSession(new Date(Date.now() - 10 * DAY_MS).toISOString());

      const r = runCli(['report', root], { env });

      expect(r.stdout).toMatch(/^sessions: 1, from /m);
      expect(r.stdout).not.toMatch(WARNING);
    });

    it('keeps --json free of the window lines', () => {
      const r = runCli(['report', root, '--json'], { env });

      expect(() => JSON.parse(r.stdout)).not.toThrow();
    });
  });

  it('exits 1 on a malformed --since', () => {
    const r = runCli(['report', root, '--since', 'nope'], { env });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/nope/);
  });

  describe('export and import', () => {
    let outDir: string;

    beforeEach(() => {
      outDir = mkdtempSync(join(tmpdir(), 'kit-out-'));
      onTestFinished(() => rmSync(outDir, { recursive: true, force: true }));
    });

    it('writes a labeled export and re-renders it byte-equal below the header', () => {
      const file = join(outDir, 'out', 'work.json');
      const exported = runCli(
        ['report', root, '--export', file, '--label', 'work'],
        { env },
      );
      expect(exported.status, exported.stderr).toBe(0);
      expect(exported.stdout).toContain(
        `wrote ${file} (1 session(s), label work)`,
      );
      const meta = (
        JSON.parse(readFileSync(file, 'utf8')) as {
          meta: { label: string; since?: string };
        }
      ).meta;
      expect(meta.label).toBe('work');
      expect(meta.since).toBeUndefined();

      const live = runCli(['report', root], { env });
      const imported = runCli(['report', '--import', file], { env });
      expect(imported.status, imported.stderr).toBe(0);
      const withoutWindowLine = (out: string) =>
        out
          .split('\n')
          .slice(2)
          .filter((line) => !line.startsWith('sessions: '));
      expect(withoutWindowLine(imported.stdout)).toEqual(
        withoutWindowLine(live.stdout),
      );
    });

    it('compares two imports side by side in argument order', () => {
      const work = join(outDir, 'work.json');
      const home = join(outDir, 'home.json');
      runCli(['report', root, '--export', work, '--label', 'work'], { env });
      runCli(['report', root, '--export', home, '--label', 'home'], { env });

      const r = runCli(['report', '--import', work, '--import', home], { env });

      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/metric.*work.*home/);
    });

    it('rejects live-only flags beside --import', () => {
      const r = runCli(
        ['report', '--import', join(outDir, 'x.json'), '--since', '2026-01-01'],
        { env },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/do not apply to an import/);
    });
  });
});
