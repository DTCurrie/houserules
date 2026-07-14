import { test } from 'node:test';
import assert from 'node:assert/strict';
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

import { makeFixture, runCli, runScript, sh } from './fixtures.mjs';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const configPath = (root) => join(root, '.claude/kit.config.json');
const editConfig = (root, fn) => {
  const c = readJson(configPath(root));
  fn(c);
  writeFileSync(configPath(root), JSON.stringify(c, null, 2));
};

function stubRunner(root) {
  const path = join(root, 'stub-runner.sh');
  writeFileSync(path, '#!/bin/sh\necho "$@" >> runner-calls.txt\nexit 0\n');
  chmodSync(path, 0o755);
}
const calls = (root) =>
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
    assert.equal(r.status, 0, r.stderr);
    // Script ships, but the Stop hooks are NOT wired (they'd run nonexistent scripts).
    assert.ok(existsSync(join(root, '.claude/scripts/lint-format-fix.mjs')));
    const settings = readJson(join(root, '.claude/settings.json'));
    const stopCmds = (settings.hooks?.Stop ?? []).flatMap((g) =>
      g.hooks.map((h) => h.command),
    );
    assert.ok(
      !stopCmds.some((c) => c.includes('lint-format-fix.mjs')),
      'Stop hook not wired',
    );
    assert.match(r.stdout, /no target has a detected fix command/);

    // doctor must NOT false-WARN "hook not wired" for the deliberate gap.
    const doc = runCli(['doctor', root]);
    assert.equal(doc.status, 0, doc.stdout);
    assert.doesNotMatch(doc.stdout, /lint-format-fix\.mjs not wired/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('EG1: per-extension gate skips lint:fix on a docs-only edit; runs it on a JS edit', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
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
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(calls(root), ['--filter @fix/cityville format:fix']);

    // A JS/TS edit → both commands run.
    rmSync(join(root, 'runner-calls.txt'));
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const z=1;\n',
    );
    r = runScript(root, SCRIPT, { input: '{}' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(calls(root).sort(), [
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
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 session/);
    assert.match(r.stdout, /turns 1/);
    assert.match(r.stdout, /cache_read 900/);
    assert.match(r.stdout, /cost-weighted input-equivalent/);
    // weighted = 100 + 200*1.25 + 900*0.1 = 440
    assert.match(r.stdout, /440/);
    assert.match(r.stdout, /claude-opus-4-8/);

    // A repo with no transcripts is reported cleanly (still exit 0).
    const empty = makeFixture('non-js');
    try {
      r = runCli(['report', empty], { env });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /No transcripts found/);
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
    assert.equal(
      runCli(['init', '--yes', '--modules=statusline', root]).status,
      0,
    );
    const settings = readJson(join(root, '.claude/settings.json'));
    assert.ok(settings.statusLine, 'statusLine set when absent');
    assert.match(settings.statusLine.command, /statusline\.mjs/);
    assert.ok(existsSync(join(root, '.claude/scripts/statusline.mjs')));
    assert.equal(runCli(['doctor', root]).status, 0);

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
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[kit\]/);
    assert.match(r.stdout, /changeset/); // fixture ships 2 pending changesets
    assert.match(r.stdout, /cityville/);
    assert.match(r.stdout, /ctx 34%/);
    assert.match(r.stdout, /\$0\.12/);
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

    assert.equal(
      runCli(['init', '--yes', '--modules=statusline', root]).status,
      0,
    );
    const after = readJson(settingsPath);
    assert.equal(
      after.statusLine.command,
      'my-own-statusline',
      "user's statusLine preserved",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
