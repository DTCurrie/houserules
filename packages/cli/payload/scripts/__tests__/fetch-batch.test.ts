import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const SCRIPT = fileURLToPath(
  new URL('../../../payload-dist/scripts/fetch-batch.mjs', import.meta.url),
);
const CLI_PACKAGE = fileURLToPath(new URL('../../../', import.meta.url));

const PAGES: Record<string, string> = {
  '/page': '<h1>Title</h1><p>Hello <strong>world</strong></p>',
  '/with-main':
    '<body><nav>Menu</nav><h1>Skip me</h1><main><h1>Inside</h1><p>Main text</p><script>var x = 1;</script><footer>Foot</footer></main><aside>Side</aside></body>',
  '/with-article':
    '<body><header>Head</header><article><h2>Story</h2><p>Article text</p><button>Share</button></article><p>Outside</p></body>',
  '/with-neither':
    '<body><nav>Menu</nav><h1>Plain</h1><p>Body text</p><form><input></form><style>p{}</style><svg><title>icon</title></svg></body>',
  '/malformed-main':
    '<div><p>Unclosed <span><main><h2>Deep</h2><p>Nested text<div></main><footer>Foot',
  '/three-headings':
    '<main><h1>Alpha</h1><p>One two.</p><h2>Beta</h2><p>Three.</p><h3>Gamma</h3><p>Four five six.</p></main>',
  '/no-headings': '<main><p>Just one line.</p><p>And another.</p></main>',
  '/missing': '<main><h1>Not found</h1><p>Gone</p></main>',
  '/forbidden': '<main><h1>Denied</h1></main>',
};

const STATUS_ROUTES: Record<string, number> = {
  '/missing': 404,
  '/forbidden': 403,
};

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string): Promise<RunResult> {
  const env = { ...process.env };
  delete env.NODE_PATH;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { cwd, env, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const status =
          error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolve({ status, stdout, stderr });
      },
    );
  });
}

describe('fetch-batch.mjs (real execution)', () => {
  let server: Server;
  let base: string;
  let requests: string[];
  let outDir: string;
  let bareDir: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/hang') return;
      const status = STATUS_ROUTES[request.url ?? ''];
      const html = PAGES[request.url ?? ''];
      if (html !== undefined) {
        response.statusCode = status ?? 200;
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(html);
        return;
      }
      if (request.url === '/data') {
        response.setHeader('content-type', 'application/json');
        response.end('{"a":1}');
        return;
      }
      if (request.url === '/big') {
        response.setHeader('content-type', 'text/plain');
        response.end('x'.repeat(5000));
        return;
      }
      response.setHeader('content-type', 'text/plain');
      response.end('plain body');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    requests = [];
    outDir = join(mkdtempSync(join(tmpdir(), 'fetch-batch-')), 'out');
    bareDir = mkdtempSync(join(tmpdir(), 'fetch-batch-bare-'));
  });

  afterEach(() => {
    rmSync(join(outDir, '..'), { recursive: true, force: true });
    rmSync(bareDir, { recursive: true, force: true });
  });

  it('writes one file per URL and prints one line each in input order', async () => {
    const result = await run(
      ['--out', outDir, `${base}/data`, `${base}/text`, `${base}/big`],
      CLI_PACKAGE,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      `1\t200\t7\tapplication/json\t${outDir}/1-127.0.0.1.json`,
      `2\t200\t10\ttext/plain\t${outDir}/2-127.0.0.1.txt`,
      `3\t200\t5000\ttext/plain\t${outDir}/3-127.0.0.1.txt`,
    ]);
    expect(readFileSync(join(outDir, '1-127.0.0.1.json'), 'utf8')).toBe(
      '{"a":1}',
    );
    expect(readFileSync(join(outDir, '2-127.0.0.1.txt'), 'utf8')).toBe(
      'plain body',
    );
  });

  it('prints no page content', async () => {
    const result = await run(['--out', outDir, `${base}/text`], CLI_PACKAGE);

    expect(result.stdout).not.toContain('plain body');
  });

  it('converts an HTML page to Markdown beside the raw file', async () => {
    const result = await run(['--out', outDir, `${base}/page`], CLI_PACKAGE);

    expect(result.stdout.trim()).toBe(
      `1\t200\t49\ttext/html; charset=utf-8\t${outDir}/1-127.0.0.1.md\twords=4`,
    );
    expect(readFileSync(join(outDir, '1-127.0.0.1.md'), 'utf8')).toBe(
      '# Title\n\nHello **world**',
    );
    expect(readFileSync(join(outDir, '1-127.0.0.1.html'), 'utf8')).toBe(
      '<h1>Title</h1><p>Hello <strong>world</strong></p>',
    );
  });

  async function markdownOf(route: string): Promise<string> {
    await run(['--out', outDir, `${base}${route}`], CLI_PACKAGE);
    return readFileSync(join(outDir, '1-127.0.0.1.md'), 'utf8');
  }

  it('converts only <main> and drops the noise tags inside it', async () => {
    expect(await markdownOf('/with-main')).toBe('# Inside\n\nMain text');
  });

  it('converts only <article> when the page has no <main>', async () => {
    expect(await markdownOf('/with-article')).toBe('## Story\n\nArticle text');
  });

  it('converts the body without its noise tags when the page has neither', async () => {
    expect(await markdownOf('/with-neither')).toBe('# Plain\n\nBody text');
  });

  it('converts a <main> nested inside malformed markup', async () => {
    expect(await markdownOf('/malformed-main')).toBe('## Deep\n\nNested text');
  });

  it('writes an outline with one line per heading, level, line number, then text', async () => {
    await run(['--out', outDir, `${base}/three-headings`], CLI_PACKAGE);

    expect(readFileSync(join(outDir, '1-127.0.0.1.outline.txt'), 'utf8')).toBe(
      'h1\t1\tAlpha\nh2\t5\tBeta\nh3\t9\tGamma\n',
    );
  });

  it('writes an outline that says there are no headings and gives the line count', async () => {
    await run(['--out', outDir, `${base}/no-headings`], CLI_PACKAGE);

    expect(readFileSync(join(outDir, '1-127.0.0.1.outline.txt'), 'utf8')).toBe(
      'no headings\t3 lines\n',
    );
  });

  it('prints the Markdown word count on a converted line', async () => {
    const result = await run(
      ['--out', outDir, `${base}/three-headings`],
      CLI_PACKAGE,
    );

    expect(result.stdout.trim()).toMatch(/\twords=12$/);
  });

  it('marks a 404 and a 403 failed, keeps the raw body, and writes no Markdown', async () => {
    const result = await run(
      ['--out', outDir, `${base}/missing`, `${base}/forbidden`],
      CLI_PACKAGE,
    );

    expect(result.status).toBe(1);
    expect(result.stdout.trim().split('\n')).toEqual([
      `1\t404\t42\ttext/html; charset=utf-8\t${outDir}/1-127.0.0.1.html\tfailed`,
      `2\t403\t28\ttext/html; charset=utf-8\t${outDir}/2-127.0.0.1.html\tfailed`,
    ]);
    expect(existsSync(join(outDir, '1-127.0.0.1.md'))).toBe(false);
    expect(existsSync(join(outDir, '2-127.0.0.1.md'))).toBe(false);
  });

  it('cuts a body at --max-bytes and marks the line truncated', async () => {
    const result = await run(
      ['--out', outDir, '--max-bytes', '100', `${base}/big`],
      CLI_PACKAGE,
    );

    expect(result.stdout.trim()).toBe(
      `1\t200\t100\ttext/plain\t${outDir}/1-127.0.0.1.txt\ttruncated`,
    );
    expect(statSync(join(outDir, '1-127.0.0.1.txt')).size).toBe(100);
  });

  it('reports a URL that exceeds --timeout as an error line and exits 1 when nothing succeeded', async () => {
    const result = await run(
      ['--out', outDir, '--timeout', '300', `${base}/hang`],
      CLI_PACKAGE,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(new RegExp(`^1\\terror\\t${base}/hang\\t.+`));
  });

  it('exits 2 when there are more URLs than --max-urls', async () => {
    const result = await run(
      [
        '--out',
        outDir,
        '--max-urls',
        '2',
        `${base}/a`,
        `${base}/b`,
        `${base}/c`,
      ],
      CLI_PACKAGE,
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Got 3 URLs, the limit is 2.');
    expect(requests).toEqual([]);
  });

  it('exits 2 when --out is missing', async () => {
    const result = await run([`${base}/a`], CLI_PACKAGE);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--out is required.');
  });

  it('exits 2 when no URL is given', async () => {
    const result = await run(['--out', outDir], CLI_PACKAGE);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Give at least one URL.');
  });

  it('refuses a file: URL by name before any request reaches the server', async () => {
    const result = await run(
      ['--out', outDir, `${base}/a`, 'file:///etc/passwd'],
      CLI_PACKAGE,
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'Only http: and https: URLs are fetched, got file:///etc/passwd',
    );
    expect(requests).toEqual([]);
    expect(existsSync(outDir)).toBe(false);
  });

  it('exits 0 when one unreachable URL sits among successes', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, '127.0.0.1', resolve),
    );
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));

    const result = await run(
      [
        '--out',
        outDir,
        `${base}/text`,
        `http://127.0.0.1:${closedPort}/x`,
        `${base}/data`,
      ],
      CLI_PACKAGE,
    );

    const lines = result.stdout.trim().split('\n');
    expect(result.status).toBe(0);
    expect(lines[0]).toMatch(/^1\t200\t/);
    expect(lines[1]).toMatch(
      new RegExp(`^2\\terror\\thttp://127\\.0\\.0\\.1:${closedPort}/x\\t`),
    );
    expect(lines[2]).toMatch(/^3\t200\t/);
  });

  it('exits 1 before any request and prints the install command when turndown cannot be resolved', async () => {
    const result = await run(['--out', outDir, `${base}/page`], bareDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm install -D turndown');
    expect(result.stderr).toContain('pnpm add -D turndown');
    expect(requests).toEqual([]);
  });

  it('stores HTML as received with --raw when turndown cannot be resolved', async () => {
    const result = await run(
      ['--out', outDir, '--raw', `${base}/page`],
      bareDir,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `1\t200\t49\ttext/html; charset=utf-8\t${outDir}/1-127.0.0.1.html`,
    );
    expect(existsSync(join(outDir, '1-127.0.0.1.md'))).toBe(false);
  });
});
