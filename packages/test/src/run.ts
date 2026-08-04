import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Resolved as a PACKAGE, not by a relative path into a sibling package's dist/. A consumer
// installing @agent-kit/test from npm has no `../dist/cli.js` to reach for, only
// node_modules. `createRequire` gives synchronous resolution (`import.meta.resolve` is async
// in some runtimes and still experimental for conditions), and resolving `package.json`
// rather than the package root works even though @agent-kit/cli declares no `.` export: a
// `bin` field is never gated by `exports`, but reading it still needs the package.json path.
const require = createRequire(import.meta.url);
const cliPkgPath = require.resolve('@agent-kit/cli/package.json');
const cliPkg = require(cliPkgPath) as { bin?: Record<string, string> };
const cliBinRel = cliPkg.bin?.['agent-kit'];
if (!cliBinRel) {
  throw new Error(
    '@agent-kit/cli package.json has no "agent-kit" bin entry to resolve',
  );
}
const KIT_CLI = join(dirname(cliPkgPath), cliBinRel);

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
