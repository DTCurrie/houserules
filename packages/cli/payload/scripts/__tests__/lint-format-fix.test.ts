import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import type { HouseConfig } from '@houserules/payload/config';
import {
  affectedPackages,
  ARGV_PATH_BYTE_BUDGET,
  existingPaths,
  FIX_BUDGET_MS,
  fixArgs,
  gatePasses,
  modifiedSince,
  overrunNotice,
  pathsFromPorcelain,
  planFixSteps,
  plannedSteps,
  resolveFixSettings,
  runFixSteps,
  skipMissingScripts,
  stepArgv,
  stepTimedOut,
  killGroup,
  type FixSettings,
} from '../lint-format-fix.mjs';
import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';
import {
  editHouseConfig,
  type InstalledHouseConfig,
} from '#test/installed-tree';
import { recordedCalls, stubRunner } from '#test/runner-stub';

const SCRIPT = '.claude/scripts/lint-format-fix.mjs';

function baseConfig(overrides: Partial<HouseConfig> = {}): HouseConfig {
  return {
    targets: [
      {
        name: 'cityville',
        pathPrefix: 'games/cityville/',
        packageName: '@fix/cityville',
      },
      {
        name: 'studio',
        pathPrefix: 'apps/studio/',
        packageName: '@fix/studio',
      },
    ],
    ...overrides,
  };
}

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
      passPaths: true,
      ...fixOverrides,
    };
  });
}

describe('resolveFixSettings', () => {
  it('defaults to pnpm, --filter, and no root run when the config carries no fix block', () => {
    const settings = resolveFixSettings(baseConfig());

    expect(settings.runner).toBe('pnpm');
    expect(settings.filterFlag).toBe('--filter');
    expect(
      settings.runsAtRoot,
      'runsAtRoot false with the default filterFlag',
    ).toBe(false);
    expect(settings.runPrefix).toEqual([]);
    expect(settings.commandExtensions).toEqual({});
    expect(settings.onSubagentStop, 'onSubagentStop defaults off').toBe(false);
  });

  it('falls back to config.packageManager when fix.runner is unset', () => {
    const settings = resolveFixSettings(baseConfig({ packageManager: 'npm' }));

    expect(settings.runner).toBe('npm');
  });

  it('reads runsAtRoot from an empty fix.filterFlag', () => {
    const settings = resolveFixSettings(
      baseConfig({ fix: { filterFlag: '' } }),
    );

    expect(
      settings.runsAtRoot,
      'runsAtRoot true with an empty filterFlag',
    ).toBe(true);
  });

  it('reads fix.onSubagentStop through to the resolved settings', () => {
    const settings = resolveFixSettings(
      baseConfig({ fix: { onSubagentStop: true } }),
    );

    expect(
      settings.onSubagentStop,
      'onSubagentStop reflects fix.onSubagentStop',
    ).toBe(true);
  });

  it('resolves each target to its own fixCommands override', () => {
    const settings = resolveFixSettings(
      baseConfig({
        targets: [
          {
            name: 'cityville',
            pathPrefix: 'games/cityville/',
            packageName: '@fix/cityville',
            fixCommands: ['custom:fix'],
          },
        ],
      }),
    );

    expect(settings.packageByPath).toEqual([
      {
        prefix: 'games/cityville/',
        name: '@fix/cityville',
        commands: ['custom:fix'],
      },
    ]);
  });

  it('resolves a target with fixCommands: null to no commands at all', () => {
    const settings = resolveFixSettings(
      baseConfig({
        targets: [
          {
            name: 'cityville',
            pathPrefix: 'games/cityville/',
            packageName: '@fix/cityville',
            fixCommands: null,
          },
        ],
      }),
    );

    expect(settings.packageByPath[0]?.commands).toEqual([]);
  });

  it('matches the default lintable extensions and rejects one outside them', () => {
    const settings = resolveFixSettings(baseConfig());

    expect(
      settings.lintableExtRe.test('src/game.ts'),
      'src/game.ts matches the default lintable extensions',
    ).toBe(true);
    expect(
      settings.lintableExtRe.test('README.lock'),
      'README.lock is not a lintable extension',
    ).toBe(false);
  });

  it('matches the default generated-file pattern for CHANGELOG.md and BACKLOG.md', () => {
    const settings = resolveFixSettings(baseConfig());

    expect(
      settings.generatedFileRe.test('/packages/cli/CHANGELOG.md'),
      'CHANGELOG.md is a generated file',
    ).toBe(true);
    expect(
      settings.generatedFileRe.test('/src/game.ts'),
      'src/game.ts is not a generated file',
    ).toBe(false);
  });
});

describe('gatePasses', () => {
  it('passes an ungated command regardless of the changed extensions', () => {
    expect(
      gatePasses('lint:fix', new Set(['md']), {}),
      'an ungated command always passes',
    ).toBe(true);
  });

  it('passes a gated command when a changed extension is in its allow list', () => {
    const passes = gatePasses('lint:fix', new Set(['ts']), {
      'lint:fix': ['ts', 'tsx'],
    });

    expect(passes, 'lint:fix passes since ts is in its allow list').toBe(true);
  });

  it('fails a gated command when no changed extension is in its allow list', () => {
    const passes = gatePasses('lint:fix', new Set(['md']), {
      'lint:fix': ['ts', 'tsx'],
    });

    expect(passes, 'lint:fix fails since md is not in its allow list').toBe(
      false,
    );
  });
});

describe('affectedPackages', () => {
  const settings: FixSettings = resolveFixSettings(baseConfig());

  it('maps a changed path to its target package and records the extension', () => {
    expect(affectedPackages(['games/cityville/src/game.ts'], settings)).toEqual(
      [['@fix/cityville', ['lint:fix', 'format:fix'], new Set(['ts'])]],
    );
  });

  it('drops a path outside the default lintable extensions', () => {
    expect(affectedPackages(['games/cityville/README.lock'], settings)).toEqual(
      [],
    );
  });

  it('drops a generated file even when it carries a lintable extension', () => {
    expect(affectedPackages(['packages/cli/CHANGELOG.md'], settings)).toEqual(
      [],
    );
  });

  it('drops a path matching no configured target', () => {
    expect(affectedPackages(['unmapped/dir/file.ts'], settings)).toEqual([]);
  });
});

describe('plannedSteps', () => {
  it('emits one step per package command when the commands run per package', () => {
    const pkgs: [string, string[], Set<string>][] = [
      ['@fix/cityville', ['lint:fix'], new Set(['ts'])],
    ];

    expect(plannedSteps(pkgs, false)).toEqual([
      ['@fix/cityville', 'lint:fix', new Set(['ts'])],
    ]);
  });

  it('collapses the same script across two packages into one root step with the union of extensions', () => {
    const pkgs: [string, string[], Set<string>][] = [
      ['@fix/cityville', ['lint:fix'], new Set(['ts'])],
      ['@fix/studio', ['lint:fix'], new Set(['md'])],
    ];

    expect(plannedSteps(pkgs, true)).toEqual([
      ['(root)', 'lint:fix', new Set(['ts', 'md'])],
    ]);
  });
});

describe('fixArgs', () => {
  it('puts the package after the filter flag when one is set', () => {
    expect(fixArgs('@fix/cityville', 'lint:fix', '--filter', [], [])).toEqual([
      '--filter',
      '@fix/cityville',
      'lint:fix',
    ]);
  });

  it('drops the package name and uses the run prefix when the filter flag is empty', () => {
    expect(fixArgs('(root)', 'lint:fix', '', ['run'], [])).toEqual([
      'run',
      'lint:fix',
    ]);
  });
});

describe('planFixSteps', () => {
  it('resolves a changed file to its package’s fix commands', () => {
    const settings = resolveFixSettings(baseConfig());

    expect(planFixSteps(['games/cityville/src/game.ts'], settings)).toEqual([
      ['@fix/cityville', 'lint:fix'],
      ['@fix/cityville', 'format:fix'],
    ]);
  });

  it('drops a step gated to extensions the change did not touch, keeping an ungated sibling', () => {
    const settings = resolveFixSettings(
      baseConfig({ fix: { commandExtensions: { 'lint:fix': ['md'] } } }),
    );

    expect(planFixSteps(['games/cityville/src/game.ts'], settings)).toEqual([
      ['@fix/cityville', 'format:fix'],
    ]);
  });

  it('returns no steps for an empty file list', () => {
    const settings = resolveFixSettings(baseConfig());

    expect(planFixSteps([], settings)).toEqual([]);
  });
});

describe('pathsFromPorcelain', () => {
  it('lists each path after its two status columns', () => {
    expect(
      pathsFromPorcelain(' M apps/studio/src/main.ts\n?? notes.md\n'),
    ).toEqual(['apps/studio/src/main.ts', 'notes.md']);
  });

  it('reduces a rename to its new path', () => {
    expect(
      pathsFromPorcelain(
        'R  apps/studio/src/old.ts -> apps/studio/src/new.ts\n',
      ),
    ).toEqual(['apps/studio/src/new.ts']);
  });
});

function fileModifiedAt(dir: string, name: string, iso: string): void {
  writeFileSync(join(dir, name), 'export {};\n');
  utimesSync(join(dir, name), new Date(iso), new Date(iso));
}

describe('modifiedSince', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lint-fix-mtime-'));
  });

  it('keeps a file modified at or after the cutoff and drops one modified before it', () => {
    fileModifiedAt(dir, 'before.ts', '2026-01-01T00:00:00.000Z');
    fileModifiedAt(dir, 'at.ts', '2026-01-01T01:00:00.000Z');
    fileModifiedAt(dir, 'after.ts', '2026-01-01T02:00:00.000Z');

    expect(
      modifiedSince(['before.ts', 'at.ts', 'after.ts'], dir, 1767229200000),
    ).toEqual(['at.ts', 'after.ts']);
  });

  it('drops a path whose file no longer exists', () => {
    expect(modifiedSince(['deleted.ts'], dir, 0)).toEqual([]);
  });
});

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
    expect(recordedCalls(root)).toEqual([
      '--filter @fix/cityville fix -- src/game.ts',
    ]);
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
    expect(config.fix.onSubagentStop, 'onSubagentStop off by default').toBe(
      false,
    );
  });

  it('has no verify block by default', () => {
    expect(config.verify).toBe(undefined);
  });
});

function transcriptWith(...tools: string[]): string {
  return transcriptPromptedAt(undefined, ...tools);
}

function transcriptPromptedAt(
  timestamp: string | undefined,
  ...tools: string[]
): string {
  const dir = mkdtempSync(join(tmpdir(), 'lint-fix-transcript-'));
  const path = join(dir, 'transcript.jsonl');
  const records = [
    {
      type: 'user',
      timestamp,
      message: { role: 'user', content: 'do the thing' },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: tools.map((name) => ({ type: 'tool_use', name, input: {} })),
      },
    },
  ];
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

function runWithGitSpy(
  root: string,
  payload: Record<string, unknown>,
): { status: number | null; stderr: string; gitCalls: string[] } {
  const binDir = mkdtempSync(join(tmpdir(), 'lint-fix-git-spy-'));
  const log = join(binDir, 'git-calls.txt');
  mkdirSync(binDir, { recursive: true });
  const gitPath = join(binDir, 'git');
  writeFileSync(gitPath, `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`);
  chmodSync(gitPath, 0o755);
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: binDir + delimiter + process.env.PATH,
  };
  delete env.NODE_PATH;
  const r = spawnSync(process.execPath, [join(root, SCRIPT)], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });
  const gitCalls = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n')
    : [];
  return { status: r.status, stderr: r.stderr, gitCalls };
}

describe('lint-format-fix.mjs gating on the ended turn', () => {
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

  it('exits 0 without spawning git or the runner when the turn only used Read', () => {
    const r = runWithGitSpy(root, {
      hook_event_name: 'Stop',
      transcript_path: transcriptWith('Read'),
    });

    expect(r.status, r.stderr).toBe(0);
    expect(
      r.gitCalls.filter((args) => args.startsWith('status')),
      'git status was never spawned',
    ).toEqual([]);
    expect(existsSync(join(root, 'runner-calls.txt')), 'no runner call').toBe(
      false,
    );
  });

  it('runs the fix when the turn used Read and Edit', () => {
    const r = runScript(root, SCRIPT, {
      input: JSON.stringify({
        hook_event_name: 'Stop',
        transcript_path: transcriptWith('Read', 'Edit'),
      }),
    });

    expect(r.status, r.stderr).toBe(0);
    expect(recordedCalls(root)).toEqual([
      '--filter @fix/cityville fix -- src/game.ts',
    ]);
  });

  it('runs the fix when the payload carries no transcript_path', () => {
    const r = runScript(root, SCRIPT, {
      input: JSON.stringify({ hook_event_name: 'Stop' }),
    });

    expect(r.status, r.stderr).toBe(0);
    expect(recordedCalls(root)).toEqual([
      '--filter @fix/cityville fix -- src/game.ts',
    ]);
  });

  it('runs the fix when the transcript file is unreadable', () => {
    const r = runScript(root, SCRIPT, {
      input: JSON.stringify({
        hook_event_name: 'Stop',
        transcript_path: join(root, 'missing.jsonl'),
      }),
    });

    expect(r.status, r.stderr).toBe(0);
    expect(recordedCalls(root)).toEqual([
      '--filter @fix/cityville fix -- src/game.ts',
    ]);
  });

  it('exits 0 without spawning git or the runner while background_tasks is non-empty', () => {
    const r = runWithGitSpy(root, {
      hook_event_name: 'Stop',
      transcript_path: transcriptWith('Edit'),
      background_tasks: [{}],
    });

    expect(r.status, r.stderr).toBe(0);
    expect(
      r.gitCalls.filter((args) => args.startsWith('status')),
      'git status was never spawned',
    ).toEqual([]);
    expect(existsSync(join(root, 'runner-calls.txt')), 'no runner call').toBe(
      false,
    );
  });

  it('runs the fix when background_tasks is an empty array', () => {
    const r = runScript(root, SCRIPT, {
      input: JSON.stringify({
        hook_event_name: 'Stop',
        transcript_path: transcriptWith('Edit'),
        background_tasks: [],
      }),
    });

    expect(r.status, r.stderr).toBe(0);
    expect(recordedCalls(root)).toEqual([
      '--filter @fix/cityville fix -- src/game.ts',
    ]);
  });
});

describe('lint-format-fix.mjs scoping the fix to the ended turn', () => {
  let root: string;
  let changedFile: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    stubRunner(root);
    setRunner(root);
    changedFile = join(root, 'games/cityville/src/game.ts');
    appendFileSync(changedFile, 'export const x = 9;\n');
  });

  it('runs nothing after a Bash turn when the only change predates its prompt', () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(changedFile, at, at);

    const r = runScript(root, SCRIPT, {
      input: JSON.stringify({
        hook_event_name: 'Stop',
        transcript_path: transcriptPromptedAt(
          '2026-01-01T01:00:00.000Z',
          'Bash',
        ),
      }),
    });

    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'runner-calls.txt')), 'no runner call').toBe(
      false,
    );
  });

  it('fixes the package whose file changed after the prompt', () => {
    const at = new Date('2026-01-01T01:00:00.000Z');
    utimesSync(changedFile, at, at);

    const r = runScript(root, SCRIPT, {
      input: JSON.stringify({
        hook_event_name: 'Stop',
        transcript_path: transcriptPromptedAt(
          '2026-01-01T00:00:00.000Z',
          'Bash',
        ),
      }),
    });

    expect(r.status, r.stderr).toBe(0);
    expect(recordedCalls(root)).toEqual([
      '--filter @fix/cityville fix -- src/game.ts',
    ]);
  });
});

describe('lint-format-fix.mjs on a file in a directory git has never seen', () => {
  let root: string;
  let newDir: string;

  function runAfterPrompt(...names: string[]): ReturnType<typeof runScript> {
    const before = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(join(root, 'games/cityville/src/game.ts'), before, before);
    const after = new Date('2026-01-01T02:00:00.000Z');
    for (const name of names) {
      writeFileSync(join(newDir, name), 'export const y = 1;\n');
      utimesSync(join(newDir, name), after, after);
    }
    return runScript(root, SCRIPT, {
      input: JSON.stringify({
        hook_event_name: 'Stop',
        transcript_path: transcriptPromptedAt(
          '2026-01-01T01:00:00.000Z',
          'Bash',
        ),
      }),
    });
  }

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    stubRunner(root);
    setRunner(root);
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const x = 9;\n',
    );
    newDir = join(root, 'games/cityville/src/levels/boss');
    mkdirSync(newDir, { recursive: true });
  });

  it('fixes the package when the new directory holds a lintable file beside a non-lintable one', () => {
    const r = runAfterPrompt('Arena.tsx', 'arena.bin');

    expect(r.status, r.stderr).toBe(0);
    expect(recordedCalls(root)).toEqual([
      '--filter @fix/cityville fix -- src/levels/boss/Arena.tsx',
    ]);
  });

  it('runs nothing when the new directory holds only a non-lintable file', () => {
    const r = runAfterPrompt('arena.bin');

    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'runner-calls.txt')), 'no runner call').toBe(
      false,
    );
  });
});

describe('stepTimedOut', () => {
  it('classifies a step killed by a signal with no exit status as timed out', () => {
    expect(stepTimedOut({ status: null, signal: 'SIGKILL' })).toBe(true);
  });

  it('classifies a step that exited nonzero as not timed out', () => {
    expect(stepTimedOut({ status: 1, signal: null })).toBe(false);
  });

  it('classifies a step that exited 0 as not timed out', () => {
    expect(stepTimedOut({ status: 0, signal: null })).toBe(false);
  });
});

describe('killGroup', () => {
  it('does not throw when the group it targets has already exited', () => {
    const gone = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf-8' });
    const pid = Number(gone.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(-pid, 'SIGKILL'), 'the group is gone').toThrow();

    expect(() => killGroup(pid)).not.toThrow();
  });

  it('does nothing for a step that never got a pid', () => {
    expect(() => killGroup(undefined)).not.toThrow();
  });
});

describe('runFixSteps against the fix budget', () => {
  let root: string;
  const settings = resolveFixSettings(baseConfig());
  const steps: [string, string][] = [
    ['@fix/cityville', 'lint:fix'],
    ['@fix/cityville', 'format:fix'],
  ];

  function sleepingRunner(dir: string, seconds: number): FixSettings {
    const path = join(dir, 'sleep-runner.sh');
    writeFileSync(
      path,
      `#!/bin/sh\necho "$@" >> runner-calls.txt\nexec sleep ${seconds}\n`,
    );
    chmodSync(path, 0o755);
    return { ...settings, runner: path };
  }

  function clockReading(first: number, ...rest: number[]): () => number {
    const readings = [first, ...rest];
    let call = 0;
    return () => readings[Math.min(call++, readings.length - 1)] ?? first;
  }

  const PID_POLL_ATTEMPTS = 20;
  const PID_POLL_INTERVAL_MS = 50;

  /** Whether `pid` stops answering signal 0 within a second, allowing its reaper a moment. */
  async function pidGone(pid: number): Promise<boolean> {
    for (let attempt = 0; attempt < PID_POLL_ATTEMPTS; attempt++) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, PID_POLL_INTERVAL_MS));
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    return false;
  }

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('reports the step that outlasts the budget and skips the rest', async () => {
    const run = await runFixSteps(steps, root, sleepingRunner(root, 10), 1000);

    expect(run.overrun).toEqual({ pkg: '@fix/cityville', step: 'lint:fix' });
    expect(run.errors).toEqual([]);
    expect(recordedCalls(root), 'only the first step started').toEqual([
      '--filter @fix/cityville lint:fix',
    ]);
  });

  it('reports the first step as the overrun when the budget is spent before it starts', async () => {
    let tick = 0;
    stubRunner(root);
    const run = await runFixSteps(
      steps,
      root,
      { ...settings, runner: join(root, 'stub-runner.sh') },
      1000,
      () => (tick++ === 0 ? 0 : 5000),
    );

    expect(run.overrun).toEqual({ pkg: '@fix/cityville', step: 'lint:fix' });
    expect(existsSync(join(root, 'runner-calls.txt')), 'nothing spawned').toBe(
      false,
    );
  });

  it('counts elapsed time equal to the budget as nothing left, so the step is never started', async () => {
    stubRunner(root);
    const run = await runFixSteps(
      steps,
      root,
      { ...settings, runner: join(root, 'stub-runner.sh') },
      1000,
      clockReading(0, 1000),
    );

    expect(run.overrun).toEqual({ pkg: '@fix/cityville', step: 'lint:fix' });
    expect(
      existsSync(join(root, 'runner-calls.txt')),
      'remaining === 0 must end the run before spawning, as remaining <= 0 does',
    ).toBe(false);
  });

  it('ends the run at a later step that starts with exactly the budget elapsed, keeping the earlier step', async () => {
    stubRunner(root);
    const run = await runFixSteps(
      steps,
      root,
      { ...settings, runner: join(root, 'stub-runner.sh') },
      FIX_BUDGET_MS,
      clockReading(0, 0, FIX_BUDGET_MS),
    );

    expect(run.overrun).toEqual({ pkg: '@fix/cityville', step: 'format:fix' });
    expect(run.errors).toEqual([]);
    expect(recordedCalls(root), 'only the first step started').toEqual([
      '--filter @fix/cityville lint:fix',
    ]);
  });

  it('keeps residue from finished steps and reports no overrun when the budget holds', async () => {
    stubRunner(root, { fail: true });
    const run = await runFixSteps(
      steps,
      root,
      { ...settings, runner: join(root, 'stub-runner.sh') },
      FIX_BUDGET_MS,
    );

    expect(run.overrun).toBe(null);
    expect(run.errors.map((e) => e.step)).toEqual(['lint:fix', 'format:fix']);
  });

  it('kills the whole process group of a step that leaves a grandchild holding stdout, within the budget plus 2 seconds', async () => {
    const path = join(root, 'forking-runner.sh');
    writeFileSync(
      path,
      `#!/bin/sh\nsleep 30 &\necho $! > grandchild.pid\necho started\nsleep 30\n`,
    );
    chmodSync(path, 0o755);

    const startedAt = Date.now();
    const run = await runFixSteps(
      steps,
      root,
      { ...settings, runner: path },
      1000,
    );
    const elapsed = Date.now() - startedAt;

    expect(run.overrun).toEqual({ pkg: '@fix/cityville', step: 'lint:fix' });
    expect(elapsed, 'returned within the budget plus 2 seconds').toBeLessThan(
      3000,
    );
    const grandchild = Number(
      readFileSync(join(root, 'grandchild.pid'), 'utf-8').trim(),
    );
    expect(grandchild).toBeGreaterThan(0);
    expect(
      await pidGone(grandchild),
      `grandchild ${grandchild} still alive`,
    ).toBe(true);
  });

  it('names the step and the budget on one line', () => {
    const notice = overrunNotice(
      { pkg: '@fix/cityville', step: 'lint:fix' },
      90000,
    );

    expect(notice).toBe(
      'lint-format-fix: @fix/cityville :: lint:fix did not finish within the 90000ms fix budget, skipping the remaining steps.\n',
    );
  });
});

describe('fix.passPaths planning', () => {
  const on = (fix: Record<string, unknown> = {}): FixSettings =>
    resolveFixSettings(baseConfig({ fix: { passPaths: true, ...fix } }));

  it('hands each package step its own paths, package-relative', () => {
    expect(
      planFixSteps(
        ['games/cityville/src/game.ts', 'apps/studio/src/main.ts'],
        on(),
      ),
    ).toEqual([
      ['@fix/cityville', 'lint:fix', ['src/game.ts']],
      ['@fix/cityville', 'format:fix', ['src/game.ts']],
      ['@fix/studio', 'lint:fix', ['src/main.ts']],
      ['@fix/studio', 'format:fix', ['src/main.ts']],
    ]);
  });

  it('hands the root-shape step the root-relative union', () => {
    expect(
      planFixSteps(
        ['games/cityville/src/game.ts', 'apps/studio/src/main.ts'],
        on({ filterFlag: '', commands: ['fix'] }),
      ),
    ).toEqual([
      [
        '(root)',
        'fix',
        ['games/cityville/src/game.ts', 'apps/studio/src/main.ts'],
      ],
    ]);
  });

  it('narrows a step to its own commandExtensions', () => {
    expect(
      planFixSteps(
        ['games/cityville/src/game.ts', 'games/cityville/README.md'],
        on({ commandExtensions: { 'format:fix': ['md'] } }),
      ),
    ).toEqual([
      ['@fix/cityville', 'lint:fix', ['src/game.ts', 'README.md']],
      ['@fix/cityville', 'format:fix', ['README.md']],
    ]);
  });

  it('plans nothing when every changed path sits outside every target', () => {
    expect(planFixSteps(['docs/guide.md', 'tools/x.ts'], on())).toEqual([]);
  });

  it('leaves the steps as bare pairs and the argv unchanged when the key is off', () => {
    const settings = resolveFixSettings(baseConfig());
    const steps = planFixSteps(['games/cityville/src/game.ts'], settings);

    expect(steps[0]).toEqual(['@fix/cityville', 'lint:fix']);
    expect(stepArgv(steps[0]!, settings)).toEqual([
      '--filter',
      '@fix/cityville',
      'lint:fix',
    ]);
  });

  it('ends each step argv with -- and the paths when the key is on', () => {
    const settings = on();
    const [step] = planFixSteps(['games/cityville/src/game.ts'], settings);

    expect(stepArgv(step!, settings)).toEqual([
      '--filter',
      '@fix/cityville',
      'lint:fix',
      '--',
      'src/game.ts',
    ]);
  });

  it('drops a path whose file was deleted during the turn', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    expect(
      existingPaths(
        ['games/cityville/src/game.ts', 'games/cityville/src/gone.ts'],
        root,
      ),
    ).toEqual(['games/cityville/src/game.ts']);
  });
});

describe('skipMissingScripts', () => {
  it('skips a step whose script the package.json lacks and names the file', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    writeFileSync(
      join(root, 'games/cityville/package.json'),
      JSON.stringify({
        name: '@fix/cityville',
        scripts: { 'format:fix': 'x' },
      }),
    );
    const settings = resolveFixSettings(baseConfig());

    const result = skipMissingScripts(
      [
        ['@fix/cityville', 'lint:fix'],
        ['@fix/cityville', 'format:fix'],
      ],
      root,
      settings,
    );

    expect(result.steps).toEqual([['@fix/cityville', 'format:fix']]);
    expect(result.notices).toEqual([
      'lint-format-fix: skipped "lint:fix", no such script in games/cityville/package.json.\n',
    ]);
  });
});

describe('lint-format-fix.mjs with a missing script and with fix.passPaths', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    stubRunner(root);
  });

  it('spawns nothing for a missing script, prints one notice, and exits 0', () => {
    setRunner(root, { commands: ['lint:fix'] });
    writeFileSync(
      join(root, 'games/cityville/package.json'),
      JSON.stringify({ name: '@fix/cityville', scripts: {} }),
    );
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const x = 9;\n',
    );
    editHouseConfig(root, (config: InstalledHouseConfig) => {
      for (const target of config.targets as { fixCommands?: unknown }[])
        delete target.fixCommands;
    });

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe(
      'lint-format-fix: skipped "lint:fix", no such script in games/cityville/package.json.\n',
    );
    expect(existsSync(join(root, 'runner-calls.txt')), 'nothing spawned').toBe(
      false,
    );
  });

  it('passes the turn paths after -- when the key is on', () => {
    setRunner(root, { passPaths: true });
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const x = 9;\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(0);
    expect(recordedCalls(root)).toEqual([
      '--filter @fix/cityville fix -- src/game.ts',
    ]);
  });

  it('does not pass a path deleted during the turn', () => {
    setRunner(root, { passPaths: true });
    writeFileSync(
      join(root, 'games/cityville/src/extra.ts'),
      'export const e = 1;\n',
    );
    rmSync(join(root, 'games/cityville/src/game.ts'));

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(0);
    expect(recordedCalls(root)).toEqual([
      '--filter @fix/cityville fix -- src/extra.ts',
    ]);
  });

  it('spawns nothing when every changed path sits outside the targets', () => {
    setRunner(root, { passPaths: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs/guide.md'), '# guide\n');

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'runner-calls.txt')), 'nothing spawned').toBe(
      false,
    );
  });
});

describe('fixer timeouts: the fix', () => {
  it('spawns nothing and prints nothing on Stop when fix.passPaths is off', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    stubRunner(root);
    setRunner(root, { passPaths: false });
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const x = 9;\n',
    );

    const r = runScript(root, SCRIPT, {
      input: JSON.stringify({
        hook_event_name: 'Stop',
        transcript_path: transcriptWith('Edit'),
      }),
    });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(existsSync(join(root, 'runner-calls.txt')), 'nothing spawned').toBe(
      false,
    );
  });

  it('spawns nothing and says why once when the path list outgrows the argv budget', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    stubRunner(root);
    setRunner(root, { passPaths: true });
    const name = 'n'.repeat(90);
    for (let i = 0; i < 400; i++)
      writeFileSync(
        join(root, `games/cityville/src/${name}${i}.ts`),
        'export {};\n',
      );

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe(
      'lint-format-fix: fix for @fix/cityville had too many changed paths for one command line, so it was skipped.\n',
    );
    expect(existsSync(join(root, 'runner-calls.txt')), 'nothing spawned').toBe(
      false,
    );
  });

  it('returns the scoped argv at the byte budget and null one byte over it', () => {
    const settings = resolveFixSettings(
      baseConfig({ fix: { passPaths: true } }),
    );
    const atBudget = 'a'.repeat(ARGV_PATH_BYTE_BUDGET - 1);
    const overBudget = 'a'.repeat(ARGV_PATH_BYTE_BUDGET);

    expect(
      stepArgv(['@fix/cityville', 'lint:fix', [atBudget]], settings),
    ).toEqual(['--filter', '@fix/cityville', 'lint:fix', '--', atBudget]);
    expect(
      stepArgv(['@fix/cityville', 'lint:fix', [overBudget]], settings),
    ).toBe(null);
  });
});

describe('lintable extensions: today', () => {
  it('matches a path ending in each of the 11 extensions the fallback lists', () => {
    const { lintableExtRe } = resolveFixSettings(baseConfig());
    for (const ext of [
      'ts',
      'tsx',
      'js',
      'jsx',
      'mjs',
      'cjs',
      'svelte',
      'md',
      'json',
      'css',
      'html',
    ])
      expect(lintableExtRe.test(`src/a.${ext}`), ext).toBe(true);
  });

  it('lets an explicit list replace the fallback', () => {
    const { lintableExtRe } = resolveFixSettings(
      baseConfig({ lintableExtensions: ['ts'] }),
    );
    expect(lintableExtRe.test('src/a.mts')).toBe(false);
    expect(lintableExtRe.test('src/a.cts')).toBe(false);
  });
});

describe('lintable extensions: the change', () => {
  it('matches a .mts and a .cts path through the fallback', () => {
    const { lintableExtRe } = resolveFixSettings(baseConfig());
    expect(
      lintableExtRe.test('packages/cli/payload/scripts/lint-format-fix.mts'),
    ).toBe(true);
    expect(lintableExtRe.test('src/config.cts')).toBe(true);
  });
});
