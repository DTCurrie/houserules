import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';

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
    const projDir = join(cfgDir, 'projects', top.replaceAll('/', '-'));
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'sess-abcdef12.jsonl'),
      [
        JSON.stringify({
          type: 'assistant',
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
});
