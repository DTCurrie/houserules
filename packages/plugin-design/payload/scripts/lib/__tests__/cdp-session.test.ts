import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';

import { connect, discoverChrome } from '../cdp-session.mts';

class FakeSocket extends EventTarget {
  static latest: FakeSocket;
  sent: { id: number; method: string }[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.latest = this;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as { id: number; method: string });
  }

  close(): void {
    this.dispatchEvent(new Event('close'));
  }

  reply(data: unknown): void {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(data) }),
    );
  }
}

async function openConnection() {
  const connection = await connect('ws://fake');
  return { connection, socket: FakeSocket.latest };
}

describe('connect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves a call with the reply result', async () => {
    const { connection, socket } = await openConnection();
    const call = connection.send('Page.enable');
    socket.reply({ id: socket.sent[0]!.id, result: { ok: 1 } });
    await expect(call).resolves.toEqual({ ok: 1 });
  });

  it('rejects a call Chrome never answers, naming the method and the bound', async () => {
    const { connection } = await openConnection();
    const call = connection.send('Page.navigate');
    const outcome = expect(call).rejects.toThrow(
      'Chrome did not answer Page.navigate within 30000 ms',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
  });

  it('rejects a pending call, naming its method, when the socket closes', async () => {
    const { connection, socket } = await openConnection();
    const call = connection.send('Page.navigate');
    const outcome = expect(call).rejects.toThrow(
      'the Chrome debugging socket closed before Page.navigate answered',
    );
    socket.close();
    await outcome;
  });

  it('rejects a call issued after the socket closed', async () => {
    const { connection, socket } = await openConnection();
    socket.close();
    await expect(connection.send('Page.enable')).rejects.toThrow(
      'closed before Page.enable was sent',
    );
  });

  it('drops a reply that arrives after its call timed out', async () => {
    const { connection, socket } = await openConnection();
    const call = connection.send('Page.navigate');
    const outcome = expect(call).rejects.toThrow('did not answer');
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
    expect(() =>
      socket.reply({ id: socket.sent[0]!.id, result: {} }),
    ).not.toThrow();
  });

  it('does not throw when closed twice or with nothing pending', async () => {
    const { connection } = await openConnection();
    expect(() => {
      connection.close();
      connection.close();
    }).not.toThrow();
  });
});

const SESSION_MODULE_URL = pathToFileURL(
  join(import.meta.dirname, '..', 'cdp-session.mts'),
).href;
const POLL_MS = 100;
const TEARDOWN_BUDGET_MS = 10_000;
const LAUNCH_TEST_TIMEOUT_MS = 60_000;

interface AbandonedLaunch {
  profileDirs: string[];
  exitSignal: NodeJS.Signals | null;
  exitCode: number | null;
}

function chromePidsFor(profileDir: string): number[] {
  const found = spawnSync('pgrep', ['-f', `--user-data-dir=${profileDir}`], {
    encoding: 'utf8',
  });
  return found.stdout.split('\n').filter(Boolean).map(Number);
}

async function until(isDone: () => boolean): Promise<boolean> {
  const deadline = Date.now() + TEARDOWN_BUDGET_MS;
  while (Date.now() < deadline) {
    if (isDone()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return isDone();
}

/**
 * Runs a child node process that launches `sessionCount` sessions, then ends the way `ending`
 * says without ever calling `close`. The child's TMPDIR is private, so its profile directories
 * are exactly what is left in it.
 */
async function abandonSessions(
  sessionCount: number,
  ending: 'exit' | 'SIGTERM' | 'SIGINT',
): Promise<AbandonedLaunch> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cdp-abandon-'));
  onTestFinished(() => rmSync(tempRoot, { recursive: true, force: true }));
  const script = `
    const { launchSession } = await import(${JSON.stringify(SESSION_MODULE_URL)});
    for (let index = 0; index < ${sessionCount}; index += 1) {
      const launched = await launchSession();
      if (!launched.ok) { console.error(launched.error); process.exit(2); }
    }
    const { readdirSync } = await import('node:fs');
    console.log(JSON.stringify(readdirSync(process.env.TMPDIR).filter((name) => name.startsWith('houserules-design-'))));
    ${ending === 'exit' ? 'process.exit(0);' : `process.kill(process.pid, '${ending}'); setInterval(() => {}, 1000);`}
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TMPDIR: tempRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  expect(stderr, 'the child failed to launch').toBe('');
  const profileDirs = (JSON.parse(stdout.trim() || '[]') as string[]).map(
    (name) => join(tempRoot, name),
  );
  return {
    profileDirs,
    exitSignal: exited.signal,
    exitCode: exited.code,
  };
}

describe.skipIf(!discoverChrome())('a session abandoned without close', () => {
  it(
    'leaves no Chrome process and no profile directory after the process exits',
    async () => {
      const abandoned = await abandonSessions(1, 'exit');

      const isTornDown = await until(
        () =>
          abandoned.profileDirs.length === 1 &&
          chromePidsFor(abandoned.profileDirs[0]!).length === 0 &&
          !existsSync(abandoned.profileDirs[0]!),
      );

      expect(abandoned.exitCode).toBe(0);
      expect(
        isTornDown,
        `profile dirs seen: ${abandoned.profileDirs.join(', ')}`,
      ).toBe(true);
    },
    LAUNCH_TEST_TIMEOUT_MS,
  );

  it(
    'kills every Chrome when two sessions were launched in one process',
    async () => {
      const abandoned = await abandonSessions(2, 'exit');

      const isTornDown = await until(() =>
        abandoned.profileDirs.every(
          (dir) => chromePidsFor(dir).length === 0 && !existsSync(dir),
        ),
      );

      expect(abandoned.profileDirs).toHaveLength(2);
      expect(isTornDown).toBe(true);
    },
    LAUNCH_TEST_TIMEOUT_MS,
  );

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'cleans up on %s and still terminates the process by that signal',
    async (signal) => {
      const abandoned = await abandonSessions(1, signal);

      const isTornDown = await until(
        () =>
          abandoned.profileDirs.length === 1 &&
          chromePidsFor(abandoned.profileDirs[0]!).length === 0 &&
          !existsSync(abandoned.profileDirs[0]!),
      );

      expect(abandoned.exitSignal).toBe(signal);
      expect(isTornDown).toBe(true);
    },
    LAUNCH_TEST_TIMEOUT_MS,
  );
});
