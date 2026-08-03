import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The BUILT entry, not the sources: vitest's globalSetup compiles src/ → dist/
// before any suite runs, so this is always current.
const KIT_CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// vitest exports NODE_PATH pointing at pnpm's virtual store, so a child could resolve
// a dependency the fixture never installed and invert any absence-premised test.
function cleanEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.NODE_PATH;
  return env;
}

/**
 * Runs a command inside a directory and returns its stdout.
 *
 * `execFileSync`, so the arguments are passed as an argv array and never go through a shell.
 * Nothing is interpolated and nothing needs quoting. Throws on a non-zero exit, which is what
 * you want for setup steps like `git add`.
 */
export function runIn(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Runs the kit CLI as a subprocess. Never throws, so a test can assert on the exit code. */
export function runCli(
  args: string[],
  opts: Parameters<typeof spawnSync>[2] = {},
): RunResult {
  return spawnSync(process.execPath, [KIT_CLI, ...args], {
    encoding: 'utf8',
    ...opts,
    env: cleanEnv(opts?.env),
  }) as RunResult;
}

/** Runs an installed payload script inside a target repo, hook-style with JSON on stdin. */
export function runScript(
  root: string,
  rel: string,
  { input = '', args = [] }: { input?: string; args?: string[] } = {},
): RunResult {
  return spawnSync(process.execPath, [join(root, rel), ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
    env: cleanEnv(),
  }) as RunResult;
}
