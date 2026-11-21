import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cases, hookCaseEnv } from '../suites/hooks.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HAS_BUILD = existsSync(join(REPO, 'packages', 'cli', 'payload-dist'));
const SKIP = HAS_BUILD
  ? false
  : `no build at ${REPO}/packages/cli/payload-dist. Run pnpm build first.`;

function wiredCommands() {
  const settings = JSON.parse(
    readFileSync(join(REPO, '.claude', 'settings.json'), 'utf8'),
  );
  return Object.entries(settings.hooks).flatMap(([event, groups]) =>
    groups.flatMap((group) =>
      group.hooks.map((hook) => ({ event, command: hook.command })),
    ),
  );
}

describe('hookCaseEnv', () => {
  it('turns pnpm dependency verification off and points at the project', () => {
    const env = hookCaseEnv('/tmp/home', '/tmp/project');
    assert.equal(env.pnpm_config_verify_deps_before_run, 'false');
    assert.equal(env.CLAUDE_PROJECT_DIR, '/tmp/project');
  });
});

describe('hooks suite', { skip: SKIP }, () => {
  let workDir;
  let suite;

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'bench-hooks-test-'));
    suite = await cases({ root: REPO, repoDir: REPO, workDir });
  });

  after(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('returns one case per wired hook, and two per Stop hook', () => {
    const wired = wiredCommands();
    const casesFor = (command) =>
      suite.filter((benchCase) => benchCase.args[1] === command);

    const observed = wired.map(
      ({ event, command }) => `${event} x${casesFor(command).length}`,
    );

    assert.deepEqual(
      observed,
      wired.map(({ event }) => `${event} x${event === 'Stop' ? 2 : 1}`),
    );
    assert.equal(
      suite.length,
      observed.length + wired.filter(({ event }) => event === 'Stop').length,
    );
  });

  it('splits each Stop hook into a clean-tree and a dirty-tree case', () => {
    const stopCommands = wiredCommands().filter(
      ({ event }) => event === 'Stop',
    );

    const states = stopCommands.map(({ command }) =>
      suite
        .filter((benchCase) => benchCase.args[1] === command)
        .map((benchCase) => benchCase.name.split('-').pop()),
    );

    assert.notEqual(
      stopCommands.length,
      0,
      'the settings wire no Stop hook, so this test checks nothing',
    );
    assert.deepEqual(
      states,
      stopCommands.map(() => ['clean', 'dirty']),
    );
  });

  it('names every case uniquely in kebab-case and runs it under workDir', () => {
    const names = suite.map((benchCase) => benchCase.name);

    const misplaced = suite
      .filter(
        (benchCase) =>
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(benchCase.name) ||
          !benchCase.cwd.startsWith(workDir),
      )
      .map((benchCase) => `${benchCase.name} in ${benchCase.cwd}`);

    assert.equal(new Set(names).size, names.length, names.join(', '));
    assert.deepEqual(misplaced, []);
  });

  it('runs every case once to an expected exit status', (t) => {
    const failures = [];
    const outputs = new Map();
    for (const benchCase of suite) {
      benchCase.beforeEach?.();
      const startedAt = process.hrtime.bigint();
      const result = spawnSync(benchCase.command, benchCase.args, {
        cwd: benchCase.cwd,
        env: { ...process.env, ...benchCase.env },
        input: benchCase.stdin,
        encoding: 'utf8',
        timeout: benchCase.timeoutMs ?? 60_000,
      });
      const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const expectExit = benchCase.expectExit ?? [0];
      t.diagnostic(
        `${benchCase.name} exit=${result.status} expect=[${expectExit}] ${wallMs.toFixed(0)}ms`,
      );
      if (result.signal !== null || !expectExit.includes(result.status))
        failures.push(
          `${benchCase.name} exited ${result.status} (${result.signal}), expected [${expectExit}]: ${result.stderr}`,
        );
      outputs.set(benchCase.name, result);
    }

    assert.deepEqual(failures, []);
    assert.match(
      outputs.get('ledger-inject').stdout,
      /\[houserules backlog\] BENCH-a1b2c3/,
    );
    assert.match(
      outputs.get('session-context').stdout,
      /\[houserules\] branch: main/,
    );
  });
});
