import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';

import { STDERR, STREAM, TRANSCRIPTS } from './layout.mjs';

const MS_PER_MINUTE = 60_000;
/** The built-in tools that reach the network. Bash is covered by `NETWORK_SANDBOX`. */
const NETWORK_TOOLS = 'WebFetch,WebSearch';
/**
 * The `--settings` JSON that sandboxes Bash with no allowed network domains. `failIfUnavailable`
 * makes a platform that cannot sandbox (Linux without bubblewrap and socat) abort the session
 * instead of running Bash unsandboxed, and `allowUnsandboxedCommands: false` removes the retry
 * outside the sandbox. `--settings` sits above the project and local files that
 * `--setting-sources project,local` loads, so the sample repo cannot turn it off.
 */
const NETWORK_SANDBOX = {
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [] },
  },
};

/**
 * The argv after `claude` for one child session, prompt right after `-p`.
 *
 * @param {{ prompt: string, model: string, perRun: number, tools?: string, isNetworkAllowed?: boolean }} options
 *   `tools`, when set, adds `--tools <value>`, as preflight probe (a) passes `""`. `isNetworkAllowed`
 *   `false` adds `--disallowedTools WebFetch,WebSearch` and `--settings` with `NETWORK_SANDBOX`. `true` or absent adds nothing, so the
 *   preflight calls, which pass none, keep their argv.
 * @returns {string[]}
 */
export function childArgv(options) {
  const argv = [
    '-p',
    options.prompt,
    '--model',
    options.model,
    '--permission-mode',
    'auto',
    '--setting-sources',
    'project,local',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-budget-usd',
    String(options.perRun),
  ];
  if (options.tools !== undefined) argv.push('--tools', options.tools);
  if (options.isNetworkAllowed === false) {
    argv.push('--disallowedTools', NETWORK_TOOLS);
    argv.push('--settings', JSON.stringify(NETWORK_SANDBOX));
  }
  return argv;
}

/**
 * A copy of `env` with every variable whose name starts with `CLAUDE` removed.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function childEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith('CLAUDE')),
  );
}

/**
 * `claude --version` under `childEnv(env)`, trimmed.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function claudeVersion(env) {
  const result = spawnSync('claude', ['--version'], {
    env: childEnv(env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  return result.stdout.trim();
}

/**
 * Parses a `stream.jsonl` file: every JSON line, skipping lines that do not parse.
 *
 * @param {string} streamPath
 * @returns {object[]}
 */
function readStream(streamPath) {
  const events = [];
  for (const line of readFileSync(streamPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object') events.push(parsed);
    } catch {
      // A truncated line from a killed child is expected.
    }
  }
  return events;
}

function copyTranscripts(home, sessionId, outDir) {
  const projectsDir = join(home, '.claude', 'projects');
  if (!existsSync(projectsDir)) return;
  const target = join(outDir, TRANSCRIPTS);
  for (const slug of readdirSync(projectsDir)) {
    for (const name of [`${sessionId}.jsonl`, sessionId]) {
      const source = join(projectsDir, slug, name);
      if (!existsSync(source)) continue;
      mkdirSync(target, { recursive: true });
      cpSync(source, join(target, name), { recursive: true });
    }
  }
}

/**
 * Spawns `claude` detached and kills its whole process group after `timeoutMinutes`.
 *
 * @param {{ argv: string[], cwd: string, env: NodeJS.ProcessEnv, stdio: number[], timeoutMinutes: number }} options
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean }>}
 */
function spawnWithTimeout(options) {
  const { argv, cwd, env, stdio, timeoutMinutes } = options;
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = spawn('claude', argv, { cwd, env, stdio, detached: true });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    }, timeoutMinutes * MS_PER_MINUTE);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut });
    });
  });
}

/**
 * Runs one child session in `cwd` with no shell and stdin from `/dev/null`. Writes stdout to
 * `<outDir>/stream.jsonl` and stderr to `<outDir>/stderr.txt`, kills the whole process group at
 * `timeoutMinutes`, then copies `<session_id>.jsonl` and `<session_id>/` from whichever
 * `<home>/.claude/projects/*\/` holds them into `<outDir>/transcripts/`.
 *
 * @param {{
 *   cwd: string,
 *   outDir: string,
 *   argv: string[],
 *   env: NodeJS.ProcessEnv,
 *   timeoutMinutes: number,
 *   home: string,
 * }} options `env` is used as given, so the caller passes `childEnv(...)`.
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean, sessionId: string | null, resultEvent: object | null }>}
 *   `resultEvent` is the last `type: "result"` line of the stream, parsed.
 */
export async function runSession(options) {
  const { cwd, outDir, argv, env, timeoutMinutes, home } = options;
  mkdirSync(outDir, { recursive: true });
  const streamPath = join(outDir, STREAM);
  const stdinFd = openSync('/dev/null', 'r');
  const stdoutFd = openSync(streamPath, 'w');
  const stderrFd = openSync(join(outDir, STDERR), 'w');

  let outcome;
  try {
    outcome = await spawnWithTimeout({
      argv,
      cwd,
      env,
      stdio: [stdinFd, stdoutFd, stderrFd],
      timeoutMinutes,
    });
  } finally {
    closeSync(stdinFd);
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  const { exitCode, timedOut } = outcome;

  const events = readStream(streamPath);
  const sessionId =
    events.findLast((event) => typeof event.session_id === 'string')
      ?.session_id ?? null;
  const resultEvent =
    events.findLast((event) => event.type === 'result') ?? null;
  if (sessionId !== null) copyTranscripts(home, sessionId, outDir);
  return { exitCode, timedOut, sessionId, resultEvent };
}
