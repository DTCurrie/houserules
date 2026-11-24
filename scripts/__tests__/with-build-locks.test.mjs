import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../with-build-locks.mjs', import.meta.url),
);
const require = createRequire(import.meta.url);
const lockfile = createRequire(require.resolve('wireit/package.json'))(
  'proper-lockfile',
);
const POLL_MS = 50;
// wireit's own proper-lockfile windows.
const WIREIT_STALE_MS = 10_000;
const WIREIT_UPDATE_MS = 2_000;
const WIREIT_STALE_MS_PLUS_SLACK = WIREIT_STALE_MS + 3_000;

const MARKER_WRITING_CHILD_SOURCE = `
import { writeFileSync } from 'node:fs';
const [marker, holdMs, exitCode] = process.argv.slice(2);
writeFileSync(marker + '.start', String(process.pid));
setTimeout(() => {
  writeFileSync(marker + '.end', '');
  process.exit(Number(exitCode));
}, Number(holdMs));
`;

let packageDir;
let lockPath;

function marker(name) {
  return join(packageDir, name);
}

function runReaderOfConsumer(command) {
  const wrapper = spawn(process.execPath, [SCRIPT, 'consumer', ...command], {
    cwd: packageDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  wrapper.stdout.on('data', (chunk) => (output += chunk));
  wrapper.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) =>
    wrapper.on('exit', (code, signal) => resolve({ code, signal, output })),
  );
  return { wrapper, exited, output: () => output };
}

function childCommand(name, holdMs, exitCode = 0) {
  return [
    process.execPath,
    'child.mjs',
    name,
    String(holdMs),
    String(exitCode),
  ];
}

async function waitFor(predicate) {
  while (!predicate()) await sleep(POLL_MS);
}

async function lockUpstreamLikeWireit() {
  for (;;) {
    try {
      return await lockfile.lock(lockPath, {
        stale: WIREIT_STALE_MS,
        update: WIREIT_UPDATE_MS,
      });
    } catch (error) {
      if (error.code !== 'ELOCKED') throw error;
      await sleep(POLL_MS);
    }
  }
}

describe('with-build-locks', () => {
  before(() => {
    packageDir = mkdtempSync(join(tmpdir(), 'with-build-locks-'));
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        wireit: {
          upstream: { command: 'true', files: [], output: ['out/**'] },
          unlocked: { command: 'true', output: [] },
          consumer: {
            command: 'true',
            dependencies: ['upstream', 'unlocked'],
          },
        },
      }),
    );
    writeFileSync(join(packageDir, 'child.mjs'), MARKER_WRITING_CHILD_SOURCE);
    lockPath = join(
      packageDir,
      '.wireit',
      Buffer.from('upstream').toString('hex'),
      'lock',
    );
  });

  after(() => rmSync(packageDir, { recursive: true, force: true }));

  it('runs two readers of one upstream at the same time', async () => {
    const first = runReaderOfConsumer(childCommand('overlap-a', 1_500));
    const second = runReaderOfConsumer(childCommand('overlap-b', 1_500));
    await waitFor(
      () =>
        existsSync(marker('overlap-a.start')) &&
        existsSync(marker('overlap-b.start')),
    );
    assert.equal(
      existsSync(marker('overlap-a.end')),
      false,
      'reader a finished before reader b started',
    );
    assert.equal(
      existsSync(marker('overlap-b.end')),
      false,
      'reader b finished before reader a started',
    );
    assert.equal((await first.exited).code, 0);
    assert.equal((await second.exited).code, 0);
  });

  it('holds off an exclusive lock until the last reader exits', async () => {
    const first = runReaderOfConsumer(childCommand('hold-a', 1_000));
    await waitFor(() => existsSync(marker('hold-a.start')));
    const second = runReaderOfConsumer(childCommand('hold-b', 3_500));
    await waitFor(() => existsSync(marker('hold-b.start')));
    const release = await lockUpstreamLikeWireit();
    assert.equal(
      existsSync(marker('hold-a.end')),
      true,
      'exclusive lock taken while reader a ran',
    );
    assert.equal(
      existsSync(marker('hold-b.end')),
      true,
      'exclusive lock taken while reader b, the last, ran',
    );
    await release();
    await first.exited;
    await second.exited;
  });

  it('waits while wireit itself holds the lock', async () => {
    const release = await lockUpstreamLikeWireit();
    const reader = runReaderOfConsumer(childCommand('wait', 0));
    await waitFor(() => reader.output().includes('waiting for the lock on'));
    assert.match(reader.output(), /waiting for the lock on .*:upstream/);
    assert.equal(
      existsSync(marker('wait.start')),
      false,
      'reader ran under the exclusive lock',
    );
    await release();
    assert.equal((await reader.exited).code, 0);
    assert.equal(
      existsSync(marker('wait.end')),
      true,
      'reader never ran once the lock was free',
    );
  });

  it(
    'stops holding the lock within the stale window once a reader is SIGKILLed',
    { timeout: 30_000 },
    async () => {
      const reader = runReaderOfConsumer(childCommand('killed', 60_000));
      await waitFor(() => existsSync(marker('killed.start')));
      const childPid = Number(readFileSync(marker('killed.start'), 'utf8'));
      try {
        reader.wrapper.kill('SIGKILL');
        await reader.exited;
        const killedAt = Date.now();
        assert.equal(
          await lockfile.check(lockPath, { stale: WIREIT_STALE_MS }),
          true,
          'lock was not held when the reader was SIGKILLed',
        );
        const release = await lockUpstreamLikeWireit();
        const waitedMs = Date.now() - killedAt;
        assert.ok(
          waitedMs < WIREIT_STALE_MS_PLUS_SLACK,
          `lock still held ${waitedMs} ms after the reader was SIGKILLed`,
        );
        await release();
      } finally {
        process.kill(childPid, 'SIGKILL');
      }
    },
  );

  it('passes the command exit code through', async () => {
    assert.equal(
      (await runReaderOfConsumer(childCommand('code', 0, 3)).exited).code,
      3,
    );
  });

  it('runs a chained sh -c command and passes its exit code through', async () => {
    const reader = runReaderOfConsumer([
      'sh',
      '-c',
      `${process.execPath} child.mjs chain-a 0 0 && ${process.execPath} child.mjs chain-b 0 7`,
    ]);
    assert.equal((await reader.exited).code, 7);
    assert.equal(
      existsSync(marker('chain-a.end')),
      true,
      'first chained command did not run',
    );
    assert.equal(
      existsSync(marker('chain-b.end')),
      true,
      'second chained command did not run',
    );
  });
});
