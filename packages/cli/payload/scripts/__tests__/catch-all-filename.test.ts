import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { checkFilename } from '../catch-all-filename.mjs';

const SCRIPT = fileURLToPath(
  new URL(
    '../../../payload-dist/scripts/catch-all-filename.mjs',
    import.meta.url,
  ),
);

function run(cwd: string, args: string[]) {
  const env = { ...process.env };
  delete env.NODE_PATH;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env,
  });
}

describe('checkFilename', () => {
  it('reports nothing for a file named for its job', () => {
    const report = checkFilename('src/retry-policy.ts');
    expect(report.findings).toEqual([]);
  });

  it.each([
    'types.ts',
    'constants.ts',
    'utils.ts',
    'shared.ts',
    'helpers.ts',
    'Utils.tsx',
    'helpers.mts',
  ])('flags %s', (name) => {
    const report = checkFilename(`src/${name}`);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe(
      'code-cleanliness/no-catch-all-files',
    );
    expect(report.findings[0]?.file).toBe(`src/${name}`);
  });

  it('does not flag a name that merely contains a blocked word', () => {
    const report = checkFilename('src/type-utils-helper.ts');
    expect(report.findings).toEqual([]);
  });
});

describe('catch-all-filename.mjs (built script, real execution)', () => {
  let cwd: string;

  it('exits 0 and reports nothing for a well-named file', () => {
    cwd = mkdtempSync(join(tmpdir(), 'catch-all-filename-'));
    const target = join(cwd, 'src/retry-policy.ts');
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(target, 'export {};');
    const result = run(cwd, ['src/retry-policy.ts']);
    rmSync(cwd, { recursive: true, force: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('No findings');
  });

  it('exits 1 on a catch-all filename', () => {
    cwd = mkdtempSync(join(tmpdir(), 'catch-all-filename-'));
    const target = join(cwd, 'src/utils.ts');
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(target, 'export {};');
    const result = run(cwd, ['src/utils.ts']);
    rmSync(cwd, { recursive: true, force: true });
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain('code-cleanliness/no-catch-all-files');
  });
});
