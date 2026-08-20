/**
 * A Chrome DevTools Protocol session over node's global `WebSocket`.
 *
 * Zero dependencies by design. The payload may not import Playwright, Puppeteer, or `ws`, and
 * `payload/__test__/dependencies.test.ts` enforces that. Node's `WebSocket` has been global and
 * stable since 22.4, and houserules already requires node `>=22`, so the protocol is reachable
 * without any of them.
 *
 * Chrome is discovered, never installed. Every failure path returns a message rather than
 * throwing, because a design check that dies with a stack trace is worse than one that says
 * plainly it could not run.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where Chrome usually is, in the order worth trying. `CHROME_PATH` wins over all of them. */
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const LAUNCH_POLL_INTERVAL_MS = 100;
const LAUNCH_POLL_ATTEMPTS = 60;
const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const EXIT_WAIT_MS = 2000;
const PROFILE_REMOVE_RETRIES = 10;
const PROFILE_REMOVE_RETRY_MS = 50;
const NAVIGATE_SETTLE_MS = 600;

/** An evaluated expression's value, or the reason it could not be produced. */
export type SessionResult<TValue> =
  { ok: true; value: TValue } | { ok: false; error: string };

export interface RenderSession {
  /** Loads a target and waits for it to settle. */
  navigate(url: string): Promise<SessionResult<void>>;
  /** Runs an expression in the page and returns its value, which must be JSON-serializable. */
  evaluate<TValue>(expression: string): Promise<SessionResult<TValue>>;
  /** Captures a PNG and returns its bytes. Callers write it to disk and print the path. */
  screenshot(): Promise<SessionResult<Buffer>>;
  /** Always safe to call, including after a failed launch. */
  close(): Promise<void>;
}

/**
 * The Chrome executable this machine has, or undefined. Checked with `accessSync` rather than
 * `existsSync` so a path that exists but is not executable is treated as absent.
 */
export function discoverChrome(): string | undefined {
  const fromEnvironment = process.env.CHROME_PATH;
  const candidates = fromEnvironment
    ? [fromEnvironment, ...CHROME_CANDIDATES]
    : CHROME_CANDIDATES;
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Polls the debugging endpoint until Chrome answers with a browser websocket URL. */
/**
 * Reads the port Chrome actually bound out of the `DevToolsActivePort` file it writes into the
 * profile directory on startup.
 *
 * Asking for port 0 and reading back what was chosen is what keeps two sessions from colliding.
 * A fixed port made this flaky under any concurrency, since the second Chrome cannot bind it, and
 * made it briefly dangerous: a stale Chrome still holding the port would answer the poll, and the
 * session would drive somebody else's browser.
 */
async function waitForBoundPort(
  profileDir: string,
): Promise<number | undefined> {
  const portFile = join(profileDir, 'DevToolsActivePort');
  for (let attempt = 0; attempt < LAUNCH_POLL_ATTEMPTS; attempt += 1) {
    try {
      const [port] = readFileSync(portFile, 'utf8').split('\n');
      const parsed = Number.parseInt(port ?? '', 10);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    } catch {
      // Chrome has not written the file yet.
    }
    await wait(LAUNCH_POLL_INTERVAL_MS);
  }
  return undefined;
}

async function waitForDebuggerUrl(port: number): Promise<string | undefined> {
  for (let attempt = 0; attempt < LAUNCH_POLL_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      const info = (await response.json()) as { webSocketDebuggerUrl?: string };
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
    } catch {
      // Chrome is not listening yet.
    }
    await wait(LAUNCH_POLL_INTERVAL_MS);
  }
  return undefined;
}

interface Connection {
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
  close(): void;
}

function connect(url: string): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map<
      number,
      {
        resolve: (value: Record<string, unknown>) => void;
        reject: (reason: Error) => void;
      }
    >();
    let nextId = 0;

    socket.addEventListener('error', () =>
      reject(new Error('the Chrome debugging socket errored')),
    );
    socket.addEventListener('message', (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        error?: { message: string };
        result?: Record<string, unknown>;
      };
      if (message.id === undefined) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result ?? {});
    });
    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}, sessionId) {
          return new Promise((resolveSend, rejectSend) => {
            nextId += 1;
            pending.set(nextId, { resolve: resolveSend, reject: rejectSend });
            socket.send(
              JSON.stringify({ id: nextId, method, params, sessionId }),
            );
          });
        },
        close: () => socket.close(),
      });
    });
  });
}

/**
 * Resolves once the child has actually exited, or after {@link EXIT_WAIT_MS} either way.
 *
 * `kill()` only sends the signal. Chrome still holds files open in its profile directory for a
 * moment afterward, and deleting it in that window fails intermittently with `ENOTEMPTY`.
 */
function processExited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, EXIT_WAIT_MS);
    child.once('exit', done);
  });
}

/**
 * Deletes the temp profile, retrying on the transient errors a just-killed Chrome produces.
 * Never throws: a leaked temp directory is not worth failing a design check over.
 */
function removeProfileDir(profileDir: string): void {
  try {
    rmSync(profileDir, {
      recursive: true,
      force: true,
      maxRetries: PROFILE_REMOVE_RETRIES,
      retryDelay: PROFILE_REMOVE_RETRY_MS,
    });
  } catch {
    // The OS reclaims the temp directory eventually.
  }
}

/** Everything a launched session needs to tear down, held together so `close` is total. */
interface Launched {
  chrome: ChildProcess;
  connection: Connection;
  sessionId: string;
  profileDir: string;
}

async function attachPage(connection: Connection): Promise<string> {
  const created = (await connection.send('Target.createTarget', {
    url: 'about:blank',
  })) as { targetId: string };
  const attached = (await connection.send('Target.attachToTarget', {
    targetId: created.targetId,
    flatten: true,
  })) as { sessionId: string };
  return attached.sessionId;
}

function buildSession(launched: Launched): RenderSession {
  const { chrome, connection, sessionId, profileDir } = launched;
  let closed = false;

  // The trailing comma is required: in a .mts file a bare `<TValue>` parses as JSX.
  const guard = async <TValue,>(
    run: () => Promise<TValue>,
  ): Promise<SessionResult<TValue>> => {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  };

  return {
    navigate(url) {
      return guard(async () => {
        await connection.send('Page.navigate', { url }, sessionId);
        // Page.loadEventFired would be tighter, but it needs an event listener the flat
        // session does not expose here. A settle delay keeps this dependency-free.
        await wait(NAVIGATE_SETTLE_MS);
      });
    },
    evaluate<TValue>(expression: string) {
      return guard(async () => {
        const evaluated = (await connection.send(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
        )) as {
          result?: { value?: TValue };
          exceptionDetails?: { text: string };
        };
        if (evaluated.exceptionDetails) {
          throw new Error(evaluated.exceptionDetails.text);
        }
        return evaluated.result?.value as TValue;
      });
    },
    screenshot() {
      return guard(async () => {
        const captured = (await connection.send(
          'Page.captureScreenshot',
          { format: 'png' },
          sessionId,
        )) as { data: string };
        return Buffer.from(captured.data, 'base64');
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        connection.close();
      } catch {
        // The socket may already be gone.
      }
      chrome.kill();
      await processExited(chrome);
      removeProfileDir(profileDir);
    },
  };
}

/**
 * Launches a headless Chrome and attaches a page session to it.
 *
 * @returns The session, or the reason one could not be started. A missing Chrome is the
 *   expected failure and reads as guidance, not as an error.
 */
export async function launchSession(
  viewport = DEFAULT_VIEWPORT,
): Promise<SessionResult<RenderSession>> {
  const executable = discoverChrome();
  if (!executable) {
    return {
      ok: false,
      error:
        'no Chrome or Chromium found. The rendered checks need one installed locally. Set CHROME_PATH to point at it, or skip the rendered tier.',
    };
  }

  const profileDir = mkdtempSync(join(tmpdir(), 'houserules-design-'));
  const chrome = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      // /dev/shm is small inside containers, and Chrome crashes on startup when it fills.
      // Writing shared memory to a temp file instead costs nothing outside one.
      '--disable-dev-shm-usage',
      // Chrome's sandbox needs unprivileged user namespaces, which Ubuntu 24.04 and most
      // hardened container images deny, so Chrome exits before it opens a port. Off by default
      // because dropping the sandbox is a real weakening. CI opts in.
      ...(process.env.CHROME_NO_SANDBOX ? ['--no-sandbox'] : []),
      'about:blank',
    ],
    // Chrome's own stderr is the only thing that says WHY a launch failed. Discarding it turns
    // every cause into the same unhelpful timeout.
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let chromeStderr = '';
  chrome.stderr?.on('data', (chunk: Buffer) => {
    chromeStderr += chunk.toString();
  });

  // A Chrome that dies on startup often says nothing at all, so the exit status is the only
  // evidence left. Without it every cause reads as the same timeout.
  let exit: { code: number | null; signal: string | null } | undefined;
  chrome.on('exit', (code, signal) => {
    exit = { code, signal };
  });
  let spawnError: string | undefined;
  chrome.on('error', (error) => {
    spawnError = error.message;
  });

  const abandon = async (
    error: string,
  ): Promise<SessionResult<RenderSession>> => {
    // Read the exit state BEFORE killing, or the kill below writes it and every launch reads as
    // having exited on its own. Died-by-itself versus never-came-up is the whole diagnosis.
    const exitedOnItsOwn = exit;
    chrome.kill();
    await processExited(chrome);
    removeProfileDir(profileDir);
    const detail = [
      `chrome: ${executable}`,
      spawnError ? `spawn failed: ${spawnError}` : undefined,
      exitedOnItsOwn
        ? `exited on its own with ${exitedOnItsOwn.signal ? `signal ${exitedOnItsOwn.signal}` : `code ${exitedOnItsOwn.code}`}`
        : 'was still running when we gave up waiting',
      chromeStderr.trim() || 'it wrote nothing to stderr',
    ].filter(Boolean);
    return { ok: false, error: [error, ...detail].join('\n  ') };
  };

  const port = await waitForBoundPort(profileDir);
  if (!port) {
    return await abandon('Chrome started but never opened its debugging port.');
  }

  const debuggerUrl = await waitForDebuggerUrl(port);
  if (!debuggerUrl) {
    return await abandon(`Chrome bound port ${port} but never answered on it.`);
  }

  try {
    const connection = await connect(debuggerUrl);
    const sessionId = await attachPage(connection);
    await connection.send('Page.enable', {}, sessionId);
    await connection.send(
      'Emulation.setDeviceMetricsOverride',
      { ...viewport, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    return {
      ok: true,
      value: buildSession({ chrome, connection, sessionId, profileDir }),
    };
  } catch (error) {
    return await abandon((error as Error).message);
  }
}
