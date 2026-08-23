import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runIn, runScript } from '#test/run';
import {
  editHouseConfig,
  type InstalledHouseConfig,
} from '#test/installed-tree';
import { recordedCalls, stubRunner } from '#test/runner-stub';

const SCRIPT = '.claude/scripts/lint-format-fix.mjs';

function setRunner(
  root: string,
  fixOverrides: Record<string, unknown> = {},
): void {
  editHouseConfig(root, (config: InstalledHouseConfig) => {
    config.fix = {
      runner: './stub-runner.sh',
      filterFlag: '--filter',
      runScriptPrefix: ['run'],
      commands: ['lint:fix', 'format:fix'],
      ...fixOverrides,
    };
  });
}

describe('lint-format-fix.mjs on a changed package in a monorepo', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    stubRunner(root);
    setRunner(root);
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const x = 9;\n',
    );
  });

  it('invokes the runner once with --filter <pkg> using the target’s fixCommands override', () => {
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, r.stderr).toBe(0);
    expect(recordedCalls(root)).toEqual(['--filter @fix/cityville fix']);
  });
});

describe('lint-format-fix.mjs when the runner fails', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    stubRunner(root, { fail: true });
    setRunner(root);
    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const y = 9;\n',
    );
  });

  it('exits 2 with a trimmed residue tail on stderr', () => {
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/residual issues/);
    expect(r.stderr).toMatch(/unfixable problem/);
  });

  it('exits 0 when stop_hook_active short-circuits a repeat run', () => {
    const r = runScript(root, SCRIPT, { input: '{"stop_hook_active":true}' });
    expect(r.status).toBe(0);
  });
});

describe('lint-format-fix.mjs on SubagentStop', () => {
  let root: string;
  let calls: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    calls = join(root, 'runner-calls.txt');
    stubRunner(root);
    setRunner(root);
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const x = 9;\n',
    );
  });

  it('is a no-op by default, since parallel workers would each fix every changed package at once and clobber siblings mid-edit', () => {
    const sub = '{"hook_event_name":"SubagentStop"}';
    expect(runScript(root, SCRIPT, { input: sub }).status).toBe(0);
    expect(existsSync(calls), 'no fix commands run on SubagentStop').toBe(
      false,
    );
  });

  it('still fixes on Stop, the one pass per fan-out', () => {
    expect(
      runScript(root, SCRIPT, { input: '{"hook_event_name":"Stop"}' }).status,
    ).toBe(0);
    expect(readFileSync(calls, 'utf8')).toMatch(/--filter @fix\/cityville fix/);
  });

  it('runs on SubagentStop when fix.onSubagentStop opts back in', () => {
    setRunner(root, { onSubagentStop: true });
    const sub = '{"hook_event_name":"SubagentStop"}';
    expect(runScript(root, SCRIPT, { input: sub }).status).toBe(0);
    expect(readFileSync(calls, 'utf8')).toMatch(/--filter @fix\/cityville fix/);
  });
});

describe('lint-format-fix.mjs seeded houserules.config.json', () => {
  let root: string;
  let config: { fix: { onSubagentStop: boolean }; verify?: unknown };

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    config = JSON.parse(
      readFileSync(join(root, '.claude/houserules.config.json'), 'utf8'),
    );
  });

  it('carries fix.onSubagentStop: false', () => {
    expect(config.fix.onSubagentStop).toBe(false);
  });

  it('has no verify block by default', () => {
    expect(config.verify).toBe(undefined);
  });
});

describe('lint-format-fix.mjs in a workspace whose fix scripts live at the root', () => {
  let root: string;

  function touchBothPackages(): void {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const x = 9;\n',
    );
    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const y = 9;\n',
    );
  }

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    stubRunner(root);
    setRunner(root, { filterFlag: '' });
  });

  it('runs each distinct root script once, not once per affected package', () => {
    touchBothPackages();

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(0);
    expect(recordedCalls(root)).toEqual(['run fix']);
  });

  it('drops the package name from the argv, since the root script takes none', () => {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const x = 9;\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(0);
    expect(recordedCalls(root)).toEqual(['run fix']);
  });
});

describe('lint-format-fix.mjs when a target sets fixCommands to null', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    stubRunner(root);
    setRunner(root);
    editHouseConfig(root, (config: InstalledHouseConfig) => {
      const targets = config.targets as Array<{
        name: string;
        fixCommands: string[] | null;
      }>;
      for (const target of targets)
        if (target.name === 'cityville') target.fixCommands = null;
    });
  });

  it('runs nothing for a change confined to that target', () => {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const x = 9;\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(0);
    expect(
      existsSync(join(root, 'runner-calls.txt')),
      'a null fixCommands still ran the global commands',
    ).toBe(false);
  });

  it('still fixes a sibling target that declares its own commands', () => {
    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const y = 9;\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(0);
    expect(recordedCalls(root)).toEqual(['--filter @fix/studio fix']);
  });
});

describe('lint-format-fix.mjs in a single-package repo (no filter flag)', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('npm-single');
    stubRunner(root);
    setRunner(root, { filterFlag: '' });
  });

  it('uses the run-prefix form for the detected fixCommand', () => {
    appendFileSync(join(root, 'src/index.js'), 'exports.more = 1;\n');
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, r.stderr).toBe(0);
    expect(recordedCalls(root)).toEqual(['run lint:fix']);
  });

  it('does not run the fixer when only a generated ledger file changed', () => {
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'clean baseline']);
    writeFileSync(join(root, 'BACKLOG.md'), '# Backlog\n');
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status).toBe(0);
    expect(
      existsSync(join(root, 'runner-calls.txt')),
      'generated-only change ran the fixer',
    ).toBe(false);
  });
});
