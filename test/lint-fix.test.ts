import { expect, test } from 'vitest';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli, runScript, sh } from './fixtures.js';

const SCRIPT = '.claude/scripts/lint-format-fix.mjs';

function stubRunner(root: string, { fail = false } = {}): void {
  const path = join(root, 'stub-runner.sh');
  writeFileSync(
    path,
    `#!/bin/sh\necho "$@" >> runner-calls.txt\n${fail ? 'echo "1 unfixable problem" >&2; exit 1' : 'exit 0'}\n`,
  );
  chmodSync(path, 0o755);
}

interface KitConfig {
  fix?: Record<string, unknown>;
  [key: string]: unknown;
}

function setRunner(
  root: string,
  fixOverrides: Record<string, unknown> = {},
): void {
  const configPath = join(root, '.claude/kit.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as KitConfig;
  config.fix = {
    runner: './stub-runner.sh',
    filterFlag: '--filter',
    runScriptPrefix: ['run'],
    commands: ['lint:fix', 'format:fix'],
    ...fixOverrides,
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

test('L1: changed package → runner invoked with --filter <pkg> fix (per-target override)', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    stubRunner(root);
    setRunner(root);
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const x = 9;\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, r.stderr).toBe(0);
    const calls = readFileSync(join(root, 'runner-calls.txt'), 'utf8')
      .trim()
      .split('\n');
    // fixCommands ["fix"] from detection overrides global commands — exactly one call.
    expect(calls).toEqual(['--filter @fix/cityville fix']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('L2: failing fix → exit 2 with residue tail; stop_hook_active short-circuits', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    stubRunner(root, { fail: true });
    setRunner(root);
    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const y = 9;\n',
    );

    let r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/residual issues/);
    expect(r.stderr).toMatch(/unfixable problem/);

    r = runScript(root, SCRIPT, { input: '{"stop_hook_active":true}' });
    expect(r.status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('L4: SubagentStop is a no-op by default; fix.onSubagentStop opts back in', () => {
  const root = makeFixture('pnpm-monorepo');
  const calls = join(root, 'runner-calls.txt');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    stubRunner(root);
    setRunner(root);
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const x = 9;\n',
    );

    // Parallel workers each hitting SubagentStop would fix every changed package at
    // once, clobbering siblings mid-edit. Default: don't run at all.
    const sub = '{"hook_event_name":"SubagentStop"}';
    expect(runScript(root, SCRIPT, { input: sub }).status).toBe(0);
    expect(
      !existsSync(calls),
      'no fix commands run on SubagentStop',
    ).toBeTruthy();

    // Stop (the parent turn) still fixes — that's the one pass per fan-out.
    expect(
      runScript(root, SCRIPT, { input: '{"hook_event_name":"Stop"}' }).status,
    ).toBe(0);
    expect(readFileSync(calls, 'utf8')).toMatch(/--filter @fix\/cityville fix/);

    rmSync(calls, { force: true });
    setRunner(root, { onSubagentStop: true });
    expect(runScript(root, SCRIPT, { input: sub }).status).toBe(0);
    expect(readFileSync(calls, 'utf8')).toMatch(/--filter @fix\/cityville fix/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('L5: seeded kit.config.json carries fix.onSubagentStop: false', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const config = JSON.parse(
      readFileSync(join(root, '.claude/kit.config.json'), 'utf8'),
    ) as { fix: { onSubagentStop: boolean }; verify?: unknown };
    expect(config.fix.onSubagentStop).toBe(false);
    expect(config.verify, 'verify block not seeded by default').toBe(undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('L3: single-package (no filter flag) uses run-prefix form; generated files ignored', () => {
  const root = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    stubRunner(root);
    setRunner(root, { filterFlag: '' });
    appendFileSync(join(root, 'src/index.js'), 'exports.more = 1;\n');

    let r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, r.stderr).toBe(0);
    const calls = readFileSync(join(root, 'runner-calls.txt'), 'utf8')
      .trim()
      .split('\n');
    expect(calls).toEqual(['run lint:fix']); // detected fixCommands ["lint:fix"]

    // Only a generated ledger file changed → no runner calls.
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-qm', 'wip']);
    rmSync(join(root, 'runner-calls.txt'));
    writeFileSync(join(root, 'BACKLOG.md'), '# Backlog\n');
    r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status).toBe(0);
    expect(
      !existsSync(join(root, 'runner-calls.txt')),
      'generated-only change ran the fixer',
    ).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
