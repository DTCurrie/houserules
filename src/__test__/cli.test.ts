import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { useRepo } from '#test/repo';
import { runCli, type RunResult } from '#test/run';

describe('claude-kit with no subcommand', () => {
  it('exits 1', () => {
    expect(runCli([]).status).toBe(1);
  });

  it('prints usage on stderr', () => {
    expect(runCli([]).stderr).toMatch(/Usage: claude-kit/);
  });

  it('leaves stdout empty', () => {
    expect(runCli([]).stdout).toBe('');
  });
});

describe('claude-kit --help', () => {
  it('exits 0 and prints usage to stdout', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: claude-kit/);
  });

  it('documents the exit-code contract', () => {
    expect(runCli(['--help']).stdout).toMatch(/Exit codes:/);
  });
});

describe('claude-kit --version', () => {
  it('exits 0 and prints a semver on stdout', () => {
    const r = runCli(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('an unknown top-level command', () => {
  it('exits non-zero rather than doing nothing', () => {
    const r = runCli(['frobnicate']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown command/i);
  });
});

describe('flags are scoped per subcommand, the point of the commander rewrite over the old flat parser', () => {
  it.each([
    { args: ['init', '--force'], case: 'init rejects --force' },
    {
      args: ['update', '--modules', 'ledger'],
      case: 'update rejects --modules, an init-only flag',
    },
  ])('rejects an unknown option: $case', ({ args }) => {
    const r = runCli(args);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown option/i);
  });
});

describe('--cwd', () => {
  let viaCwd: string;
  let viaPositional: string;

  beforeEach(() => {
    viaCwd = useRepo('npm-single');
    viaPositional = useRepo('npm-single');
  });

  it('is honored when no positional directory is given', () => {
    expect(runCli(['init', '--yes', '--cwd', viaCwd]).status).toBe(0);
    expect(
      readFileSync(join(viaCwd, '.claude/kit.config.json'), 'utf8').length,
    ).toBeGreaterThan(0);
  });

  it('loses to a positional directory when both are given', () => {
    expect(
      runCli(['init', '--yes', viaPositional, '--cwd', viaCwd]).status,
    ).toBe(0);
    expect(
      readFileSync(join(viaPositional, '.claude/kit.config.json'), 'utf8')
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('doctor', () => {
  it('exits 0 on a healthy install', () => {
    const root = useRepo('pnpm-monorepo');
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
  });

  describe('--json', () => {
    let result: RunResult;
    let parsed: Record<string, unknown>;

    beforeEach(() => {
      const root = useRepo('pnpm-monorepo');
      expect(runCli(['init', '--yes', root]).status).toBe(0);
      result = runCli(['doctor', root, '--json']);
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    });

    it('emits an object with every CI-contract key', () => {
      for (const key of [
        'ok',
        'exitCode',
        'root',
        'configProblems',
        'findings',
        'readouts',
        'counts',
      ]) {
        expect(
          parsed,
          `"${key}" is part of the --json contract`,
        ).toHaveProperty(key);
      }
    });

    it('sets exitCode to the process exit status', () => {
      expect(parsed.exitCode).toBe(result.status);
    });
  });

  describe('a schema-invalid kit.config.json', () => {
    let root: string;

    beforeEach(() => {
      root = useRepo('npm-single');
      expect(runCli(['init', '--yes', root]).status).toBe(0);
      const path = join(root, '.claude/kit.config.json');
      const config = JSON.parse(readFileSync(path, 'utf8')) as Record<
        string,
        unknown
      >;
      (config.changesets as Record<string, unknown>).baseBranchh = 'main';
      writeFileSync(path, JSON.stringify(config, null, 2));
    });

    it('exits 2, distinct from the 1 a broken install exits with', () => {
      expect(runCli(['doctor', root]).status).toBe(2);
    });

    it('names the unrecognized field on stdout', () => {
      expect(runCli(['doctor', root]).stdout).toMatch(
        /baseBranchh is not a known changesets setting/,
      );
    });

    it('surfaces exitCode 2 and a non-empty configProblems list via --json', () => {
      const asJson = JSON.parse(runCli(['doctor', root, '--json']).stdout) as {
        configProblems: string[];
        exitCode: number;
      };
      expect(asJson.exitCode).toBe(2);
      expect(asJson.configProblems.length).toBeGreaterThan(0);
    });
  });
});
