import { describe, expect, it, onTestFinished } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'payload-dist/scripts/version-check.mjs',
);
const CACHE = '.claude/state/version-check.json';

interface SeenRequest {
  url: string | undefined;
  headers: IncomingHttpHeaders;
}

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kit-vcheck-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function stubRegistry(
  versions: Record<string, string>,
): Promise<{ url: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    const match = /^\/-\/package\/(.+)\/dist-tags$/.exec(req.url ?? '');
    const version = match ? versions[decodeURIComponent(match[1]!)] : undefined;
    if (!version) {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ latest: version, next: '9.9.9-next.1' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => void server.close());
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
  };
}

function scrubbedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key === 'NODE_ENV' ||
      key === 'CI' ||
      key === 'CONTINUOUS_INTEGRATION' ||
      key === 'NO_UPDATE_NOTIFIER' ||
      key.startsWith('CI_') ||
      key === 'npm_config_registry'
    )
      continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

function run(
  args: string[],
  extraEnv: Record<string, string>,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: scrubbedEnv(extraEnv),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

function readCache(root: string): {
  checkedAt: string;
  latest: Record<string, string>;
  announced?: unknown;
} {
  return JSON.parse(readFileSync(join(root, CACHE), 'utf8'));
}

describe('version-check', () => {
  it('writes the latest dist-tag per package with the exact request shape', async () => {
    const root = tmp();
    const registry = await stubRegistry({
      '@houserules/cli': '1.4.2',
      '@houserules/plugin-prose': '0.9.0',
      'plain-pkg': '2.0.1',
    });
    const result = await run(
      [root, '@houserules/cli', '@houserules/plugin-prose', 'plain-pkg'],
      { npm_config_registry: `${registry.url}//` },
    );
    expect(result).toEqual({ code: 0, stdout: '' });
    const cache = readCache(root);
    expect(cache.latest).toEqual({
      '@houserules/cli': '1.4.2',
      '@houserules/plugin-prose': '0.9.0',
      'plain-pkg': '2.0.1',
    });
    expect(Number.isNaN(Date.parse(cache.checkedAt))).toBe(false);
    expect(registry.seen.map((r) => r.url).sort()).toEqual(
      [
        '/-/package/@houserules%2fcli/dist-tags',
        '/-/package/@houserules%2fplugin-prose/dist-tags',
        '/-/package/plain-pkg/dist-tags',
      ].sort(),
    );
    for (const request of registry.seen) {
      expect(request.headers['user-agent']).toBe('houserules');
      expect(request.headers.accept).toBe('application/json');
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
    }
  });

  it('leaves out a package whose lookup failed but keeps the rest', async () => {
    const root = tmp();
    const registry = await stubRegistry({ 'plain-pkg': '2.0.1' });
    await run([root, 'missing-pkg', 'plain-pkg'], {
      npm_config_registry: registry.url,
    });
    expect(readCache(root).latest).toEqual({ 'plain-pkg': '2.0.1' });
  });

  it('exits 0 with no output and an empty latest when the registry is unreachable', async () => {
    const root = tmp();
    const result = await run([root, '@houserules/cli'], {
      npm_config_registry: `http://127.0.0.1:1`,
    });
    expect(result).toEqual({ code: 0, stdout: '' });
    const cache = readCache(root);
    expect(cache.latest).toEqual({});
    expect(Number.isNaN(Date.parse(cache.checkedAt))).toBe(false);
  });

  it('carries an existing announced entry through unchanged', async () => {
    const root = tmp();
    const announced = {
      'plain-pkg': { version: '1.0.0', at: '2026-01-01T00:00:00.000Z' },
    };
    mkdirSync(join(root, '.claude/state'), { recursive: true });
    writeFileSync(
      join(root, CACHE),
      JSON.stringify({
        checkedAt: '2020-01-01T00:00:00.000Z',
        latest: {},
        announced,
      }),
    );
    const registry = await stubRegistry({ 'plain-pkg': '2.0.1' });
    await run([root, 'plain-pkg'], { npm_config_registry: registry.url });
    const cache = readCache(root);
    expect(cache.announced).toEqual(announced);
    expect(cache.latest).toEqual({ 'plain-pkg': '2.0.1' });
    expect(cache.checkedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('writes nothing and sends no request when no package is named', async () => {
    const root = tmp();
    const registry = await stubRegistry({});
    const result = await run([root], { npm_config_registry: registry.url });
    expect(result.code).toBe(0);
    expect(registry.seen).toEqual([]);
    expect(existsSync(join(root, CACHE))).toBe(false);
  });

  describe.each([
    ['NODE_ENV=test', { NODE_ENV: 'test' }],
    ['NO_UPDATE_NOTIFIER', { NO_UPDATE_NOTIFIER: '1' }],
    ['CI=1', { CI: '1' }],
    ['CI_FOO=x', { CI_FOO: 'x' }],
  ])('skipped environment %s', (_label, env) => {
    it('makes no request and writes no cache', async () => {
      const root = tmp();
      const registry = await stubRegistry({ 'plain-pkg': '2.0.1' });
      const result = await run([root, 'plain-pkg'], {
        ...env,
        npm_config_registry: registry.url,
      });
      expect(result).toEqual({ code: 0, stdout: '' });
      expect(registry.seen).toEqual([]);
      expect(existsSync(join(root, CACHE))).toBe(false);
    });
  });

  it('makes a request when CI=false and no CI_ variable is set', async () => {
    const root = tmp();
    const registry = await stubRegistry({ 'plain-pkg': '2.0.1' });
    await run([root, 'plain-pkg'], {
      CI: 'false',
      npm_config_registry: registry.url,
    });
    expect(registry.seen).toHaveLength(1);
    expect(readCache(root).latest).toEqual({ 'plain-pkg': '2.0.1' });
  });
});
