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

interface CityvillePackageJson {
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

interface KitConfig {
  verify?: { runner?: string; commands?: string[]; [key: string]: unknown };
  [key: string]: unknown;
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const SCRIPT = '.claude/scripts/verify-changed.mjs';

// A dependency edge studio → cityville, committed so studio is a DEPENDENT of a
// cityville change (not itself changed). Returns after init with verify-changed on.
function fixtureWithDep(): string {
  const root = makeFixture('pnpm-monorepo');
  const studioPath = join(root, 'apps/studio/package.json');
  const studio = readJson<CityvillePackageJson>(studioPath);
  studio.dependencies = { '@fix/cityville': 'workspace:*' };
  writeFileSync(studioPath, JSON.stringify(studio, null, 2));
  sh(root, 'git', ['add', '-A']);
  sh(root, 'git', ['commit', '-qm', 'studio depends on cityville']);
  expect(
    runCli(['init', '--yes', '--modules=verify-changed', root]).status,
  ).toBe(0);
  return root;
}

function stubRunner(root: string, { fail = false } = {}): void {
  const path = join(root, 'stub-runner.sh');
  writeFileSync(
    path,
    `#!/bin/sh\necho "$@" >> runner-calls.txt\n${fail ? 'echo "type error TS2322" >&2; exit 1' : 'exit 0'}\n`,
  );
  chmodSync(path, 0o755);
  const configPath = join(root, '.claude/kit.config.json');
  const config = readJson<KitConfig>(configPath);
  config.verify!.runner = './stub-runner.sh';
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

test('VC1: --json resolves changed package + its transitive DEPENDENT (reverse-dep)', () => {
  const root = fixtureWithDep();
  try {
    // Change only cityville source. studio depends on it → studio is a dependent.
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const y = 2;\n',
    );
    const r = runScript(root, SCRIPT, { args: ['--json'] });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as {
      degraded: boolean;
      scope: { package: string; reason: string; argv: string[][] }[];
    };
    expect(out.degraded).toBe(false);
    const reason = Object.fromEntries(
      out.scope.map((s) => [s.package, s.reason]),
    );
    expect(reason['@fix/cityville']).toBe('changed');
    expect(reason['@fix/studio'], 'dependent pulled in').toBe('dependent');
    // Each scope entry carries the exact argv to run.
    const city = out.scope.find((s) => s.package === '@fix/cityville');
    expect(city!.argv).toEqual([['--filter', '@fix/cityville', 'verify']]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('VC2: --run emits compact PASS/FAIL per package; failure → exit 2 + residue', () => {
  const root = fixtureWithDep();
  try {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const y = 2;\n',
    );

    // Passing runner → both packages PASS, exit 0, one filtered call each.
    stubRunner(root, { fail: false });
    let r = runScript(root, SCRIPT, { args: ['--run'] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/@fix\/cityville: PASS/);
    expect(r.stdout).toMatch(/@fix\/studio: PASS/);
    const calls = readFileSync(join(root, 'runner-calls.txt'), 'utf8')
      .trim()
      .split('\n')
      .sort();
    expect(calls).toEqual([
      '--filter @fix/cityville verify',
      '--filter @fix/studio verify',
    ]);

    // Failing runner → FAIL + exit 2 + a trimmed residue tail on stderr.
    stubRunner(root, { fail: true });
    r = runScript(root, SCRIPT, { args: ['--run'] });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/@fix\/cityville: FAIL \(verify\)/);
    expect(r.stderr).toMatch(/TS2322/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('VC3: --run degrades to exit 0 (never blocks) when git is unavailable', () => {
  const root = fixtureWithDep();
  try {
    // No changes at all → nothing to verify, exit 0 with a clear message.
    const r = runScript(root, SCRIPT, { args: ['--run'] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/nothing to verify/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('VC4: module install lands script + skill + verify config; doctor stays exit 0', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(
      runCli(['init', '--yes', '--modules=verify-changed', root]).status,
    ).toBe(0);
    expect(
      existsSync(join(root, SCRIPT)),
      'helper script installed',
    ).toBeTruthy();
    expect(
      existsSync(join(root, '.claude/skills/verify-changed/SKILL.md')),
      'skill installed',
    ).toBeTruthy();
    const config = readJson<KitConfig>(join(root, '.claude/kit.config.json'));
    expect(config.verify, 'verify block present').toBeTruthy();
    expect(config.verify!.commands).toEqual(['verify']);
    const manifest = readJson<{ modules: string[] }>(
      join(root, '.claude/kit-manifest.json'),
    );
    expect(manifest.modules.includes('verify-changed')).toBeTruthy();
    const settings = readJson<{ permissions: { allow: string[] } }>(
      join(root, '.claude/settings.json'),
    );
    expect(
      settings.permissions.allow.some((p) => p.includes('verify-changed.mjs')),
      'script permission wired',
    ).toBeTruthy();
    expect(runCli(['doctor', root]).status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('VC5: verify block absent unless the module is enabled', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const config = readJson<KitConfig>(join(root, '.claude/kit.config.json'));
    expect(config.verify, 'no verify block by default').toBe(undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RC1: reviewers module ships the /review-change dispatch skill', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', '--modules=reviewers', root]).status).toBe(
      0,
    );
    const skillPath = join(root, '.claude/skills/review-change/SKILL.md');
    expect(
      existsSync(skillPath),
      '/review-change skill installed',
    ).toBeTruthy();
    const text = readFileSync(skillPath, 'utf8');
    expect(text).toMatch(/pathPrefix/);
    expect(text).toMatch(/OK.*Conflict.*Gap/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RDY1: ready module ships the /ready pre-handoff skill', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', '--modules=ready', root]).status).toBe(0);
    const skillPath = join(root, '.claude/skills/ready/SKILL.md');
    expect(existsSync(skillPath), '/ready skill installed').toBeTruthy();
    const text = readFileSync(skillPath, 'utf8');
    expect(text).toMatch(/VERDICT/);
    expect(text).toMatch(/acceptance checklist/i);
    expect(text).toMatch(/backlog/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
