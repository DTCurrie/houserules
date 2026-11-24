import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { checkPackageJson } from '../wireit-lint.mjs';

const DIST_SCRIPTS = fileURLToPath(
  new URL('../../../payload-dist/scripts', import.meta.url),
);
const SHARED_LIB_DIR = fileURLToPath(
  new URL('../../../../payload/payload-dist/scripts/lib', import.meta.url),
);
const made: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wireit-lint-'));
  made.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function writePkg(dir: string, pkg: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'package.json');
  writeFileSync(path, JSON.stringify(pkg, null, 2));
  return path;
}

function lint(dir: string, pkg: unknown) {
  const text = JSON.stringify(pkg, null, 2);
  return checkPackageJson('package.json', join(dir, 'package.json'), text);
}

function rules(findings: { rule: string }[]): string[] {
  return findings.map((f) => f.rule);
}

describe('wireit/missing-block', () => {
  it('fires when a wireit script has no block', () => {
    const f = lint(tempDir(), { scripts: { build: 'wireit' }, wireit: {} });
    expect(f).toMatchObject([
      { rule: 'wireit/missing-block', level: 'error', line: 3 },
    ]);
  });

  it('does not fire when the block exists', () => {
    const f = lint(tempDir(), {
      scripts: { build: 'wireit' },
      wireit: { build: { command: 'tsc', files: ['src/**/*.ts'], output: [] } },
    });
    expect(f).toEqual([]);
  });
});

describe('wireit/orphan-block', () => {
  it('fires as a warning for a block with no script', () => {
    const f = lint(tempDir(), {
      scripts: {},
      wireit: { lint: { dependencies: [] } },
    });
    expect(f).toMatchObject([{ rule: 'wireit/orphan-block', level: 'warn' }]);
  });
});

describe('wireit/node-modules-glob', () => {
  const pkg = (files: string[]) => ({
    scripts: { x: 'wireit' },
    wireit: { x: { command: 'c', files, output: [] } },
  });

  it.each([
    ['**/*.md'],
    ['../**/x'],
    ['./**/*.ts'],
    ['*/**/*.md'],
    ['../*/**'],
  ])('fires on %s', (glob) => {
    const f = lint(tempDir(), pkg([glob]));
    expect(rules(f)).toEqual(['wireit/node-modules-glob']);
    expect(f[0]!.level).toBe('error');
  });

  it.each([['src/**/*.ts'], ['payload/**'], ['../*/payload/rules/**/*.md']])(
    'does not fire on %s',
    (glob) => {
      expect(lint(tempDir(), pkg([glob]))).toEqual([]);
    },
  );

  it('does not fire when a negated node_modules entry is present', () => {
    expect(lint(tempDir(), pkg(['**/*.md', '!**/node_modules/**']))).toEqual(
      [],
    );
  });
});

describe('wireit/missing-files and missing-output', () => {
  it('fire as warnings on a command block with neither key', () => {
    const f = lint(tempDir(), {
      scripts: { x: 'wireit' },
      wireit: { x: { command: 'c' } },
    });
    expect(rules(f).sort()).toEqual([
      'wireit/missing-files',
      'wireit/missing-output',
    ]);
    expect(f.every((x) => x.level === 'warn')).toBe(true);
  });

  it('do not fire on a block with no command', () => {
    const f = lint(tempDir(), {
      scripts: { x: 'wireit' },
      wireit: { x: { dependencies: [] } },
    });
    expect(f).toEqual([]);
  });
});

describe('wireit/unknown-dependency', () => {
  it('fires on a string dependency naming no script', () => {
    const f = lint(tempDir(), {
      scripts: { x: 'wireit' },
      wireit: { x: { dependencies: ['ghost'] } },
    });
    expect(f).toMatchObject([
      { rule: 'wireit/unknown-dependency', level: 'error' },
    ]);
  });

  it('fires on an object dependency naming no script', () => {
    const f = lint(tempDir(), {
      scripts: { x: 'wireit' },
      wireit: { x: { dependencies: [{ script: 'ghost' }] } },
    });
    expect(rules(f)).toEqual(['wireit/unknown-dependency']);
  });

  it('does not fire on an object dependency that exists', () => {
    const f = lint(tempDir(), {
      scripts: { x: 'wireit', y: 'tsc' },
      wireit: { x: { dependencies: [{ script: 'y' }] } },
    });
    expect(f).toEqual([]);
  });

  it('checks a cross-package dependency against the sibling package.json', () => {
    const root = tempDir();
    writePkg(join(root, 'a'), { scripts: { build: 'tsc' } });
    const own = join(root, 'b');
    const wireit = (dep: string) => ({
      scripts: { x: 'wireit' },
      wireit: { x: { dependencies: [dep] } },
    });
    writePkg(own, wireit('../a:build'));
    expect(lint(own, wireit('../a:build'))).toEqual([]);
    expect(rules(lint(own, wireit('../a:ghost')))).toEqual([
      'wireit/unknown-dependency',
    ]);
    expect(rules(lint(own, wireit('../nowhere:build')))).toEqual([
      'wireit/unknown-dependency',
    ]);
  });
});

describe('wireit/unreadable', () => {
  it('reports malformed JSON instead of throwing', () => {
    const f = checkPackageJson('package.json', '/x/package.json', '{ nope');
    expect(f).toMatchObject([{ rule: 'wireit/unreadable', level: 'error' }]);
  });
});

describe('wireit-lint.mjs CLI', () => {
  const staged = join(tempDir(), 'scripts');
  cpSync(DIST_SCRIPTS, staged, { recursive: true });
  cpSync(SHARED_LIB_DIR, join(staged, 'lib'), {
    recursive: true,
    filter: (src) => !src.endsWith('.d.mts'),
  });
  const SCRIPT = join(staged, 'wireit-lint.mjs');

  function run(args: string[], cwd: string) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      encoding: 'utf8',
    });
  }

  it('exits 1 when an error is found, with a repo-relative file', () => {
    const dir = tempDir();
    const path = writePkg(dir, { scripts: { b: 'wireit' } });
    const r = run([path], dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(
      /package\.json:3 {2}ERROR {2}\[wireit\/missing-block\]/,
    );
  });

  it('exits 0 when only warnings are found', () => {
    const dir = tempDir();
    const path = writePkg(dir, {
      scripts: { b: 'wireit' },
      wireit: { b: { command: 'c' } },
    });
    const r = run([path], dirname(path));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/WARN {2}\[wireit\/missing-files\]/);
  });
});
