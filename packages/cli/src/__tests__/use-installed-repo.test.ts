import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runChild(
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('prepareInstalledRepo, given two processes missing the same cold key', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'use-installed-repo-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('runs one init and hands both the same snapshot', async () => {
    const repoModule = pathToFileURL(
      createRequire(import.meta.url).resolve('@houserules/test/repo'),
    ).href;
    const counter = join(scratch, 'count-init.cjs');
    writeFileSync(
      counter,
      "if (process.argv[2] === 'init') require('node:fs').appendFileSync(process.env.INIT_COUNT_FILE, 'x');\n",
    );
    const child = join(scratch, 'child.mjs');
    writeFileSync(
      child,
      `const { prepareInstalledRepo } = await import(${JSON.stringify(repoModule)});\nconsole.log(prepareInstalledRepo('npm-single'));\n`,
    );
    const countFile = join(scratch, 'init-count.txt');
    writeFileSync(countFile, '');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KIT_TEST_SNAPSHOT_ROOT: join(scratch, 'snapshots'),
      INIT_COUNT_FILE: countFile,
      NODE_OPTIONS: `--require ${counter}`,
    };
    delete env.NODE_PATH;

    const results = await Promise.all([
      runChild(child, env),
      runChild(child, env),
    ]);

    expect(
      results.map((result) => result.status),
      results[0].stderr + results[1].stderr,
    ).toEqual([0, 0]);
    expect(results[0].stdout.trim()).toBe(results[1].stdout.trim());
    expect(readFileSync(countFile, 'utf8')).toBe('x');
  }, 120_000);
});
