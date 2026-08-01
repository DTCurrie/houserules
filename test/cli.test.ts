// The CLI surface contract: per-subcommand flags, exit codes, and the --json shape.
// These are the things a wrapper script or a CI job depends on, so they are asserted
// rather than left to the help text.

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { makeFixture, runCli } from './fixtures.js';

test('CLI1: no command prints usage on stderr and exits 1', () => {
  const r = runCli([]);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/Usage: claude-kit/);
  expect(r.stdout, 'usage must not pollute stdout').toBe('');
});

test('CLI2: --help goes to stdout and exits 0; --version prints the version', () => {
  const help = runCli(['--help']);
  expect(help.status).toBe(0);
  expect(help.stdout).toMatch(/Usage: claude-kit/);
  expect(help.stdout, 'the exit-code contract is documented in help').toMatch(
    /Exit codes:/,
  );

  const version = runCli(['--version']);
  expect(version.status).toBe(0);
  expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
});

test('CLI3: an unknown command exits non-zero rather than doing nothing', () => {
  const r = runCli(['frobnicate']);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/unknown command/i);
});

test('CLI4: flags are scoped per subcommand — init rejects --force', () => {
  // The whole point of the commander rewrite: the old flat parser accepted this
  // and silently ignored it.
  const r = runCli(['init', '--force']);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/unknown option/i);
});

test('CLI5: update rejects --modules, which is an init/modules flag', () => {
  const r = runCli(['update', '--modules', 'ledger']);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/unknown option/i);
});

test('CLI6: --cwd is honored, and a positional dir wins over it', () => {
  const viaCwd = makeFixture('npm-single');
  const viaPositional = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', '--cwd', viaCwd]).status).toBe(0);
    expect(
      readFileSync(join(viaCwd, '.claude/kit.config.json'), 'utf8').length,
    ).toBeGreaterThan(0);

    // Both given: the positional is the one that gets installed into.
    expect(
      runCli(['init', '--yes', viaPositional, '--cwd', viaCwd]).status,
    ).toBe(0);
    expect(
      readFileSync(join(viaPositional, '.claude/kit.config.json'), 'utf8')
        .length,
    ).toBeGreaterThan(0);
  } finally {
    rmSync(viaCwd, { recursive: true, force: true });
    rmSync(viaPositional, { recursive: true, force: true });
  }
});

test('CLI7: doctor --json emits parseable JSON on stdout with a stable shape', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const r = runCli(['doctor', root, '--json']);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
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
        `--json is a CI contract; "${key}" is part of it`,
      ).toHaveProperty(key);
    }
    expect(parsed.exitCode).toBe(r.status);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI8: an invalid kit.config.json exits 2, not 1', () => {
  const root = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const path = join(root, '.claude/kit.config.json');
    const config = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      unknown
    >;
    (config.changesets as Record<string, unknown>).baseBranchh = 'main';
    writeFileSync(path, JSON.stringify(config, null, 2));

    const r = runCli(['doctor', root]);
    expect(
      r.status,
      'schema failure is exit 2, distinct from a broken install',
    ).toBe(2);
    expect(r.stdout).toMatch(/baseBranchh is not a known changesets setting/);

    const asJson = JSON.parse(runCli(['doctor', root, '--json']).stdout) as {
      configProblems: string[];
      exitCode: number;
    };
    expect(asJson.exitCode).toBe(2);
    expect(asJson.configProblems.length).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI9: a healthy install exits 0', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
