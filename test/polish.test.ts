import { expect, test } from 'vitest';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeFixture, runCli, runScript, sh } from './fixtures.js';

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const configPath = (root: string) => join(root, '.claude/kit.config.json');
const editConfig = (root: string, fn: (c: any) => void) => {
  const c = readJson(configPath(root));
  fn(c);
  writeFileSync(configPath(root), JSON.stringify(c, null, 2));
};

function stubRunner(root: string) {
  const path = join(root, 'stub-runner.sh');
  writeFileSync(path, '#!/bin/sh\necho "$@" >> runner-calls.txt\nexit 0\n');
  chmodSync(path, 0o755);
}
const calls = (root: string) =>
  existsSync(join(root, 'runner-calls.txt'))
    ? readFileSync(join(root, 'runner-calls.txt'), 'utf8').trim().split('\n')
    : [];

test('DF1: lint-fix with no detected fix command → advisory, hooks NOT wired, doctor stays clean', () => {
  const root = makeFixture('npm-single');
  try {
    // Strip the only fix script so no target has a fix command.
    const pkgPath = join(root, 'package.json');
    const pkg = readJson(pkgPath);
    delete pkg.scripts['lint:fix'];
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-qm', 'drop lint:fix']);

    const r = runCli(['init', '--yes', '--modules=lint-fix', root]);
    expect(r.status, r.stderr).toBe(0);
    // Script ships, but the Stop hooks are NOT wired (they'd run nonexistent scripts).
    expect(
      existsSync(join(root, '.claude/scripts/lint-format-fix.mjs')),
    ).toBeTruthy();
    const settings = readJson(join(root, '.claude/settings.json'));
    const stopCmds = (settings.hooks?.Stop ?? []).flatMap((g: any) =>
      g.hooks.map((h: any) => h.command),
    );
    expect(
      !stopCmds.some((c: string) => c.includes('lint-format-fix.mjs')),
      'Stop hook not wired',
    ).toBeTruthy();
    expect(r.stdout).toMatch(/no target has a detected fix command/);

    // doctor must NOT false-WARN "hook not wired" for the deliberate gap.
    const doc = runCli(['doctor', root]);
    expect(doc.status, doc.stdout).toBe(0);
    expect(doc.stdout).not.toMatch(/lint-format-fix\.mjs not wired/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('EG1: per-extension gate skips lint:fix on a docs-only edit; runs it on a JS edit', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    stubRunner(root);
    // Separate commands + a gate on lint:fix; clear per-target unified fixCommands.
    editConfig(root, (c) => {
      c.fix = {
        runner: './stub-runner.sh',
        filterFlag: '--filter',
        runScriptPrefix: ['run'],
        commands: ['lint:fix', 'format:fix'],
        commandExtensions: { 'lint:fix': ['ts', 'tsx'] },
      };
      for (const t of c.targets) delete t.fixCommands;
    });
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-qm', 'wip']);
    const SCRIPT = '.claude/scripts/lint-format-fix.mjs';

    // Docs-only edit → lint:fix gated out, format:fix (ungated) still runs.
    writeFileSync(join(root, 'games/cityville/NOTES.md'), '# notes\n');
    let r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, r.stderr).toBe(0);
    expect(calls(root)).toEqual(['--filter @fix/cityville format:fix']);

    // A JS/TS edit → both commands run.
    rmSync(join(root, 'runner-calls.txt'));
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const z=1;\n',
    );
    r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, r.stderr).toBe(0);
    expect(calls(root).sort()).toEqual([
      '--filter @fix/cityville format:fix',
      '--filter @fix/cityville lint:fix',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RPT1: report aggregates transcript usage; cost-weights cache_read; empty repo says so', () => {
  const root = makeFixture('pnpm-monorepo');
  const cfgDir = mkdtempSync(join(tmpdir(), 'kit-cfg-'));
  try {
    const top = sh(root, 'git', ['rev-parse', '--show-toplevel']).trim();
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
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 900,
              cache_creation_input_tokens: 200,
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

    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfgDir };
    let r = runCli(['report', root], { env });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/1 session/);
    expect(r.stdout).toMatch(/turns 1/);
    expect(r.stdout).toMatch(/cache_read 900/);
    expect(r.stdout).toMatch(/cost-weighted input-equivalent/);
    // weighted = 100 + 200*1.25 + 900*0.1 = 440
    expect(r.stdout).toMatch(/440/);
    expect(r.stdout).toMatch(/claude-opus-4-8/);

    // A repo with no transcripts is reported cleanly (still exit 0).
    const empty = makeFixture('non-js');
    try {
      r = runCli(['report', empty], { env });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/No transcripts found/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test('SL1: statusline is wired when absent, never clobbers an existing one; script prints kit line', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    // No settings.json exists → statusLine set to the kit command.
    expect(runCli(['init', '--yes', '--modules=statusline', root]).status).toBe(
      0,
    );
    const settings = readJson(join(root, '.claude/settings.json'));
    expect(settings.statusLine, 'statusLine set when absent').toBeTruthy();
    expect(settings.statusLine.command).toMatch(/statusline\.mjs/);
    expect(
      existsSync(join(root, '.claude/scripts/statusline.mjs')),
    ).toBeTruthy();
    expect(runCli(['doctor', root]).status).toBe(0);

    // The script surfaces changeset debt + touched target + ambient ctx/cost.
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const q=1;\n',
    );
    const r = runScript(root, '.claude/scripts/statusline.mjs', {
      input: JSON.stringify({
        context_window: { used_percentage: 34 },
        cost: { total_cost_usd: 0.12 },
      }),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\[kit\]/);
    expect(r.stdout).toMatch(/changeset/); // fixture ships 2 pending changesets
    expect(r.stdout).toMatch(/cityville/);
    expect(r.stdout).toMatch(/ctx 34%/);
    expect(r.stdout).toMatch(/\$0\.12/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SL2: statusline never clobbers a user-defined statusLine', () => {
  const root = makeFixture('npm-single'); // has a settings.json
  try {
    const settingsPath = join(root, '.claude/settings.json');
    const settings = readJson(settingsPath);
    settings.statusLine = { type: 'command', command: 'my-own-statusline' };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    expect(runCli(['init', '--yes', '--modules=statusline', root]).status).toBe(
      0,
    );
    const after = readJson(settingsPath);
    expect(after.statusLine.command, "user's statusLine preserved").toBe(
      'my-own-statusline',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
