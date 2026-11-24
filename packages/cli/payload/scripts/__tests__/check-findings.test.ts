import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { loadConverter } from '@houserules/payload/html-markdown';

import { checkCovers, checkOrder, pageText } from '../check-findings.mjs';

const SCRIPT = fileURLToPath(
  new URL('../../../payload-dist/scripts/check-findings.mjs', import.meta.url),
);

const DESTINATIONS = 'phase-3,phase-4,none';

function run(args: string[]) {
  const env = { ...process.env };
  delete env.NODE_PATH;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env,
  });
}

function block(
  id: string,
  overrides: Record<string, string | null> = {},
): string {
  const fields: Record<string, string | null> = {
    tag: 'quality',
    surface: 'none',
    evidence: 'https://example.com/a → "quoted"',
    'version gate': 'n/a',
    'candidate action': 'fix-now',
    destination: 'phase-3',
    cost: 'one file',
    ...overrides,
  };
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `- **${key}:** ${value}`);
  return `### ${id} A title\n\n${lines.join('\n')}\n`;
}

describe('check-findings.mjs (real execution)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'check-findings-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, text: string): string {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  }

  function check(text: string, extra: string[] = []) {
    const path = write('report.md', text);
    const result = run(['--destinations', DESTINATIONS, ...extra, path]);
    return { path, result };
  }

  it('exits 0 on a clean report', () => {
    const { path, result } = check(
      `# Report\n\n${block('AB-01')}\n${block('AB-02', { 'candidate action': 'backlog', destination: 'none' })}`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${path}: 2 finding(s), 0 defect(s)\n`);
  });

  it('reads a report with CRLF line endings', () => {
    const { path, result } = check(block('AB-01').replace(/\n/g, '\r\n'));

    expect(result.stdout).toBe(`${path}: 1 finding(s), 0 defect(s)\n`);
    expect(result.status).toBe(0);
  });

  it('checks every report passed at once and fails when one fails', () => {
    const clean = write('clean.md', block('AB-01'));
    const bad = write('bad.md', block('CD-01', { tag: 'style' }));

    const result = run(['--destinations', DESTINATIONS, clean, bad]);

    expect(result.stdout).toBe(
      `${clean}: 1 finding(s), 0 defect(s)\n${bad}: 1 finding(s), 1 defect(s)\n  CD-01: tag "style"\n`,
    );
    expect(result.status).toBe(1);
  });

  it.each([
    { field: 'tag', line: 'AB-01: missing tag' },
    { field: 'surface', line: 'AB-01: missing surface' },
    { field: 'evidence', line: 'AB-01: missing evidence' },
    { field: 'version gate', line: 'AB-01: missing version gate' },
    { field: 'candidate action', line: 'AB-01: missing candidate action' },
    { field: 'destination', line: 'AB-01: missing destination' },
    { field: 'cost', line: 'AB-01: missing cost' },
  ])('reports a block with no $field', ({ field, line }) => {
    const { path, result } = check(block('AB-01', { [field]: null }));

    expect(result.stdout).toBe(
      `${path}: 1 finding(s), 1 defect(s)\n  ${line}\n`,
    );
    expect(result.status).toBe(1);
  });

  it('reports a tag outside the two allowed', () => {
    const { path, result } = check(block('AB-01', { tag: 'style' }));

    expect(result.stdout).toBe(
      `${path}: 1 finding(s), 1 defect(s)\n  AB-01: tag "style"\n`,
    );
  });

  it('reports a candidate action outside the five allowed', () => {
    const { path, result } = check(
      block('AB-01', { 'candidate action': 'ignore' }),
    );

    expect(result.stdout).toBe(
      `${path}: 1 finding(s), 1 defect(s)\n  AB-01: candidate action "ignore"\n`,
    );
  });

  it('reports a destination outside the passed set', () => {
    const { path, result } = check(block('AB-01', { destination: 'phase-9' }));

    expect(result.stdout).toBe(
      `${path}: 1 finding(s), 1 defect(s)\n  AB-01: destination "phase-9"\n`,
    );
  });

  it.each(['fix-now', 'adopt'])('reports %s naming none', (action) => {
    const { path, result } = check(
      block('AB-01', { 'candidate action': action, destination: 'none' }),
    );

    expect(result.stdout).toBe(
      `${path}: 1 finding(s), 1 defect(s)\n  AB-01: ${action} must name a phase, not none\n`,
    );
  });

  it.each(['backlog', 'park', 'reject'])(
    'reports %s naming a phase',
    (action) => {
      const { path, result } = check(
        block('AB-01', { 'candidate action': action, destination: 'phase-4' }),
      );

      expect(result.stdout).toBe(
        `${path}: 1 finding(s), 1 defect(s)\n  AB-01: ${action} must name none, not phase-4\n`,
      );
    },
  );

  it('reports an evidence line with neither a URL nor a backticked command', () => {
    const { path, result } = check(
      block('AB-01', {
        evidence: 'I saw it once and it looked wrong to me today',
      }),
    );

    expect(result.stdout).toBe(
      `${path}: 1 finding(s), 1 defect(s)\n  AB-01: evidence has no URL and no command: I saw it once and it looked wrong to me today\n`,
    );
  });

  it('accepts an evidence line holding only a backticked command', () => {
    const { result } = check(block('AB-01', { evidence: '`ls` → `a.md`' }));

    expect(result.status).toBe(0);
  });

  it('reports a numbering gap', () => {
    const { path, result } = check(`${block('AB-01')}\n${block('AB-03')}`);

    expect(result.stdout).toBe(
      `${path}: 2 finding(s), 1 defect(s)\n  AB-03: numbering gap, expected AB-02\n`,
    );
    expect(result.status).toBe(1);
  });

  it('reports an empty report that gives no reason', () => {
    const { path, result } = check('# Report\n\nNothing here.\n');

    expect(result.stdout).toBe(
      `${path}: 0 finding(s), 1 defect(s)\n  no findings and no statement of why\n`,
    );
    expect(result.status).toBe(1);
  });

  it('accepts an empty report that says there are no findings', () => {
    const { path, result } = check('# Report\n\nNo findings: all clean.\n');

    expect(result.stdout).toBe(`${path}: 0 finding(s), 0 defect(s)\n`);
    expect(result.status).toBe(0);
  });

  describe('--order', () => {
    const TEMPLATE = '# T\n\n## Alpha\n\n## Beta\n\n## Gamma\n';

    function runWithOrder(text: string) {
      const template = write('template.md', TEMPLATE);
      const path = write('synth.md', `${text}\n${block('SY-01')}`);
      return {
        path,
        result: run([
          '--destinations',
          DESTINATIONS,
          '--order',
          template,
          path,
        ]),
      };
    }

    it('accepts the template headings in order, ignoring other headings', () => {
      const { path, result } = runWithOrder(
        '## Alpha\n\n## Extra\n\n## Beta\n\n## Gamma\n',
      );

      expect(result.stdout).toBe(`${path}: 1 finding(s), 0 defect(s)\n`);
      expect(result.status).toBe(0);
    });

    it('reports a missing heading', () => {
      const { path, result } = runWithOrder('## Alpha\n\n## Gamma\n');

      expect(result.stdout).toBe(
        `${path}: 1 finding(s), 1 defect(s)\n  order: missing heading "## Beta"\n`,
      );
      expect(result.status).toBe(1);
    });

    it('reports a repeated heading', () => {
      const { path, result } = runWithOrder(
        '## Alpha\n\n## Beta\n\n## Beta\n\n## Gamma\n',
      );

      expect(result.stdout).toBe(
        `${path}: 1 finding(s), 3 defect(s)\n  order: heading "## Beta" appears 2 times\n  order: "## Beta" is at position 3, template has "## Gamma"\n  order: "## Gamma" is at position 4, template has "undefined"\n`,
      );
    });

    it('reports headings that are out of order', () => {
      const { path, result } = runWithOrder(
        '## Beta\n\n## Alpha\n\n## Gamma\n',
      );

      expect(result.stdout).toBe(
        `${path}: 1 finding(s), 2 defect(s)\n  order: "## Beta" is at position 1, template has "## Alpha"\n  order: "## Alpha" is at position 2, template has "## Beta"\n`,
      );
    });

    it('ignores a heading inside a code fence', () => {
      const { path, result } = runWithOrder(
        '## Alpha\n\n```\n## Beta\n```\n\n## Gamma\n',
      );

      expect(result.stdout).toBe(
        `${path}: 1 finding(s), 1 defect(s)\n  order: missing heading "## Beta"\n`,
      );
    });
  });

  describe('--covers', () => {
    function runWithCovers(reportText: string, synthesisText: string) {
      const report = write('report.md', reportText);
      const path = write('synth.md', synthesisText);
      return {
        path,
        result: run(['--destinations', DESTINATIONS, '--covers', report, path]),
      };
    }

    it('accepts a synthesis that names every report id', () => {
      const { path, result } = runWithCovers(
        `${block('AB-01')}\n${block('AB-02')}`,
        `${block('SY-01')}\nMerges AB-01 and AB-02.\n`,
      );

      expect(result.stdout).toBe(`${path}: 1 finding(s), 0 defect(s)\n`);
      expect(result.status).toBe(0);
    });

    it('reports an id that does not appear', () => {
      const { path, result } = runWithCovers(
        `${block('AB-01')}\n${block('AB-02')}`,
        `${block('SY-01')}\nMerges AB-01.\n`,
      );

      expect(result.stdout).toBe(
        `${path}: 1 finding(s), 1 defect(s)\n  covers: AB-02 does not appear\n`,
      );
      expect(result.status).toBe(1);
    });

    it('does not count XAB-01 or AB-010 as AB-01', () => {
      const { path, result } = runWithCovers(
        block('AB-01'),
        `${block('SY-01')}\nSee XAB-01 and AB-010.\n`,
      );

      expect(result.stdout).toBe(
        `${path}: 1 finding(s), 1 defect(s)\n  covers: AB-01 does not appear\n`,
      );
    });

    it('counts an id that follows a heading anchor and precedes punctuation', () => {
      const { result } = runWithCovers(
        block('AB-01'),
        `${block('SY-01')}\nSee \`report.md#AB-01\`, done.\n`,
      );

      expect(result.status).toBe(0);
    });
  });

  describe('usage errors', () => {
    it('exits 2 when --destinations is missing', () => {
      const path = write('report.md', block('AB-01'));

      const result = run([path]);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('--destinations is required');
    });

    it('exits 2 when no file is given', () => {
      const result = run(['--destinations', DESTINATIONS]);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('no file given');
    });

    it('exits 2 on an unknown option', () => {
      const path = write('report.md', block('AB-01'));

      const result = run(['--destinations', DESTINATIONS, '--bogus', path]);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('unknown option --bogus');
    });

    it('exits 2 when an option is missing its value', () => {
      const path = write('report.md', block('AB-01'));

      const result = run(['--destinations', DESTINATIONS, path, '--order']);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('--order needs a value');
    });
  });

  describe('an unreadable file', () => {
    it('names the path and exits 1', () => {
      const missing = join(dir, 'missing.md');

      const result = run(['--destinations', DESTINATIONS, missing]);

      expect(result.status).toBe(1);
      expect(result.stderr).toBe(
        `${missing}: Could not read this path (ENOENT). Pass one existing file per argument.\n`,
      );
    });
  });
});

describe('checkOrder', () => {
  it('returns no defects when the headings match in order', () => {
    expect(checkOrder('## A\n## X\n## B\n', '## A\n## B\n')).toEqual([]);
  });

  it('ignores a heading inside a fence in the template', () => {
    expect(checkOrder('## A\n', '## A\n```\n## B\n```\n')).toEqual([]);
  });

  it('reports a missing heading', () => {
    expect(checkOrder('## A\n', '## A\n## B\n')).toEqual([
      'order: missing heading "## B"',
    ]);
  });
});

describe('checkCovers', () => {
  it('counts an id once however often it is listed', () => {
    expect(checkCovers('nothing', ['AB-01', 'AB-01'])).toEqual([
      'covers: AB-01 does not appear',
    ]);
  });

  it.each(['XAB-01', 'AB-010', '1AB-01', '-AB-01'])(
    'does not count %s as AB-01',
    (text) => {
      expect(checkCovers(text, ['AB-01'])).toEqual([
        'covers: AB-01 does not appear',
      ]);
    },
  );

  it.each(['AB-01', '(AB-01)', 'x#AB-01.', 'AB-01a'])(
    'counts %s as AB-01',
    (text) => {
      expect(checkCovers(text, ['AB-01'])).toEqual([]);
    },
  );
});

function runAsync(args: string[], cwd?: string) {
  const env = { ...process.env };
  delete env.NODE_PATH;
  return new Promise<{ status: number; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        [SCRIPT, ...args],
        { encoding: 'utf8', env, cwd },
        (error, stdout, stderr) => {
          const code = error && typeof error.code === 'number' ? error.code : 0;
          resolve({ status: code, stdout, stderr });
        },
      );
    },
  );
}

describe('check-findings.mjs --verify-urls', () => {
  const PAGE =
    '<html><head><style>.x{color:red}</style><script>var q = "hidden words";</script></head>' +
    '<body><p>Tom &amp;  Jerry\n   are   &#8220;friends&#8221; &mdash; always.</p></body></html>';
  let dir: string;
  let server: Server;
  let base: string;
  let requests: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'check-findings-urls-'));
    requests = 0;
    server = createServer((request, response) => {
      requests++;
      if (request.url === '/missing') {
        response.statusCode = 404;
        response.end('nope');
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(PAGE);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  });

  function writeReport(...evidence: string[]): string {
    const path = join(dir, 'report.md');
    const lines = evidence.map((line) => `- **evidence:** ${line}`).join('\n');
    writeFileSync(
      path,
      `### AB-01 A title\n\n- **tag:** quality\n- **surface:** none\n${lines}\n- **version gate:** n/a\n- **candidate action:** fix-now\n- **destination:** phase-3\n- **cost:** one file\n`,
    );
    return path;
  }

  it('accepts a quote the page holds after entities, tags, and whitespace are normalized', async () => {
    const path = writeReport(
      `${base}/a → "Tom & Jerry are "friends" - always."`,
    );

    const result = await runAsync([
      '--destinations',
      DESTINATIONS,
      '--verify-urls',
      path,
    ]);

    expect(result.stdout).toBe(
      `${path}: 1 finding(s), 0 defect(s)\nverify-urls: 1 URL(s) fetched, 1 quote(s) checked, 0 not found, 0 unreachable, 0 unconvertible, 0 skipped past the cap\n`,
    );
    expect(result.status).toBe(0);
  });

  it('reports a quote the page lacks, including text inside a script', async () => {
    const path = writeReport(`${base}/a → "hidden words"`);

    const result = await runAsync([
      '--destinations',
      DESTINATIONS,
      '--verify-urls',
      path,
    ]);

    expect(result.stdout).toContain(
      `${path}: AB-01: quote not found at ${base}/a: "hidden words"\n`,
    );
    expect(result.stdout).toContain('1 not found');
    expect(result.status).toBe(1);
  });

  it('reports a closed port as unreachable and not as a failed quote', async () => {
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((done) => closed.close(done));
    const path = writeReport(`http://127.0.0.1:${port}/a → "anything"`);

    const result = await runAsync([
      '--destinations',
      DESTINATIONS,
      '--verify-urls',
      path,
    ]);

    expect(result.stdout).toMatch(
      new RegExp(
        `${path}: AB-01: unreachable http://127.0.0.1:${port}/a \\(.+\\)\n`,
      ),
    );
    expect(result.stdout).toContain('0 not found, 1 unreachable');
    expect(result.status).toBe(0);
  });

  it('reports a non-2xx status as unreachable', async () => {
    const path = writeReport(`${base}/missing → "anything"`);

    const result = await runAsync([
      '--destinations',
      DESTINATIONS,
      '--verify-urls',
      path,
    ]);

    expect(result.stdout).toContain(
      `${path}: AB-01: unreachable ${base}/missing (status 404)\n`,
    );
    expect(result.status).toBe(0);
  });

  it('fetches a URL cited twice once', async () => {
    const path = writeReport(
      `${base}/a → "Tom & Jerry"`,
      `${base}/a → "always."`,
    );

    const result = await runAsync([
      '--destinations',
      DESTINATIONS,
      '--verify-urls',
      path,
    ]);

    expect(result.stdout).toContain('1 URL(s) fetched, 2 quote(s) checked');
    expect(requests).toBe(1);
  });

  it('skips URLs past --max-urls and counts them', async () => {
    const path = writeReport(
      `${base}/a → "Tom & Jerry"`,
      `${base}/b → "Tom & Jerry"`,
    );

    const result = await runAsync([
      '--destinations',
      DESTINATIONS,
      '--verify-urls',
      '--max-urls',
      '1',
      path,
    ]);

    expect(result.stdout).toContain(
      '1 URL(s) fetched, 1 quote(s) checked, 0 not found, 0 unreachable, 0 unconvertible, 1 skipped past the cap',
    );
    expect(requests).toBe(1);
  });

  it('matches a quote inside emphasis and a link in the main content', async () => {
    server.removeAllListeners('request');
    server.on('request', (_request, response) => {
      requests++;
      response.setHeader('content-type', 'text/html');
      response.end(
        '<nav>menu</nav><main><p>alpha <em>beta</em> <a href="/x">gamma</a></p></main>',
      );
    });
    const path = writeReport(`${base}/a → "alpha beta gamma"`);

    const result = await runAsync([
      '--destinations',
      DESTINATIONS,
      '--verify-urls',
      path,
    ]);

    expect(result.stdout).toContain('1 quote(s) checked, 0 not found');
    expect(result.status).toBe(0);
  });

  function serve(contentType: string, body: string): void {
    server.removeAllListeners('request');
    server.on('request', (_request, response) => {
      requests++;
      response.setHeader('content-type', contentType);
      response.end(body);
    });
  }

  function verify(path: string) {
    return runAsync(['--destinations', DESTINATIONS, '--verify-urls', path]);
  }

  it('finds a table-row quote with escaped quotes in a text/plain page', async () => {
    serve(
      'text/plain; charset=utf-8',
      '| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |\n| Agent completed | VCS diff shows changes | Agent reports "success" |\n| Requirements met | Line-by-line checklist | Tests passing |\n',
    );
    const path = writeReport(
      `${base}/a → "| Agent completed | VCS diff shows changes | Agent reports \\"success\\" |"`,
    );

    const result = await verify(path);

    expect(result.stdout).toContain('1 quote(s) checked, 0 not found');
    expect(result.status).toBe(0);
  });

  it('searches a text/plain declaration file with angle brackets without converting it', async () => {
    serve(
      'text/plain',
      'export declare function first<T>(items: Array<T>): T | undefined;\n',
    );
    const path = writeReport(`${base}/a → "first<T>(items: Array<T>): T"`);

    const result = await verify(path);

    expect(result.stdout).toContain(
      '1 quote(s) checked, 0 not found, 0 unreachable, 0 unconvertible',
    );
    expect(result.status).toBe(0);
  });

  it('searches an application/json body with angle brackets in a string', async () => {
    serve('application/json', '{"type": "Promise<string>", "name": "load"}');
    const path = writeReport(`${base}/a → "Promise<string>"`);

    const result = await verify(path);

    expect(result.stdout).toContain('1 quote(s) checked, 0 not found');
    expect(result.status).toBe(0);
  });

  it('sniffs a body with no content type for a leading doctype', async () => {
    server.removeAllListeners('request');
    server.on('request', (_request, response) => {
      response.writeHead(200);
      response.end('<!DOCTYPE html><p>alpha <b>beta</b></p>');
    });
    const path = writeReport(`${base}/a → "alpha beta"`);

    const result = await verify(path);

    expect(result.stdout).toContain('1 quote(s) checked, 0 not found');
  });

  it('reports a page the converter throws on as unconvertible and not unreachable', async () => {
    serve('text/html', `${'<div>'.repeat(20000)}deep`);
    const path = writeReport(`${base}/a → "deep"`);

    const result = await verify(path);

    expect(result.stdout).toMatch(
      new RegExp(`${path}: AB-01: unconvertible ${base}/a \\(.+\\)\n`),
    );
    expect(result.stdout).toContain(
      '0 not found, 0 unreachable, 1 unconvertible',
    );
    expect(result.status).toBe(1);
  });

  it('exits 1 before any request and prints the install command when turndown cannot be resolved', async () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'check-findings-bare-'));
    try {
      const path = writeReport(`${base}/a → "Tom & Jerry"`);

      const result = await runAsync(
        ['--destinations', DESTINATIONS, '--verify-urls', path],
        bareDir,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('npm install -D turndown');
      expect(result.stderr).toContain('pnpm add -D turndown');
      expect(requests).toBe(0);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it('cuts a long not-found quote to its first 60 characters and an ellipsis', async () => {
    const quote = 'zebra '.repeat(20).trim();
    const path = writeReport(`${base}/a → "${quote}"`);

    const result = await verify(path);

    expect(result.stdout).toContain(
      `${path}: AB-01: quote not found at ${base}/a: "${quote.slice(0, 60)}..."\n`,
    );
  });

  it('names a quote that ends with punctuation the source lacks', async () => {
    serve('text/html', '<p>Agents drift without a plan</p>');
    const path = writeReport(`${base}/a → "Agents drift without a plan."`);

    const result = await verify(path);

    expect(result.stdout).toContain(
      `${path}: AB-01: quote ends with punctuation the source lacks at ${base}/a: "Agents drift without a plan."\n`,
    );
    expect(result.stdout).not.toContain('quote not found');
    expect(result.stdout).toContain('1 not found');
    expect(result.status).toBe(1);
  });

  it('passes a quote whose closing period is in the source', async () => {
    serve('text/html', '<p>Agents drift without a plan.</p>');
    const path = writeReport(`${base}/a → "Agents drift without a plan."`);

    const result = await verify(path);

    expect(result.stdout).toContain('1 quote(s) checked, 0 not found');
    expect(result.status).toBe(0);
  });

  it('still reports plain not found when trimming punctuation does not help', async () => {
    serve('text/html', '<p>Agents drift without a plan</p>');
    const path = writeReport(`${base}/a → "Agents never drift."`);

    const result = await verify(path);

    expect(result.stdout).toContain(
      `${path}: AB-01: quote not found at ${base}/a: "Agents never drift."\n`,
    );
  });

  it('finds a quote across a footnote reference in the source', async () => {
    serve(
      'text/html',
      '<p>Models forget<sup><a href="#fn1">1</a></sup> earlier turns.</p>',
    );
    const path = writeReport(`${base}/a → "Models forget earlier turns."`);

    const result = await verify(path);

    expect(result.stdout).toContain('1 quote(s) checked, 0 not found');
  });

  it('finds a quote across a LaTeXML math span in the source', async () => {
    serve(
      'text/html',
      '<p>The loss <span class="ltx_Math"><math alttext="L=0" display="inline"><semantics><mi>L</mi><annotation encoding="application/x-tex">L=0</annotation></semantics></math></span> converges.</p>',
    );
    const path = writeReport(`${base}/a → "The loss L=0 converges."`);

    const result = await verify(path);

    expect(result.stdout).toContain('1 quote(s) checked, 0 not found');
  });

  it('finds a quote across zero-width and invisible-operator characters in the source', async () => {
    serve('text/html', '<p>alpha​ beta⁡⁢⁣⁤ gamma</p>');
    const path = writeReport(`${base}/a → "alpha beta gamma"`);

    const result = await verify(path);

    expect(result.stdout).toContain('1 quote(s) checked, 0 not found');
  });

  it('still reports not found for a quote that skips an exponent the page keeps', async () => {
    serve('text/html', '<p>area is x<sup>2</sup> units</p>');
    const path = writeReport(`${base}/a → "area is x units"`);

    const result = await verify(path);

    expect(result.stdout).toContain('1 not found');
    expect(result.status).toBe(1);
  });

  it('makes no request without the flag', async () => {
    const path = writeReport(`${base}/a → "Tom & Jerry"`);

    const result = await runAsync(['--destinations', DESTINATIONS, path]);

    expect(result.stdout).toBe(`${path}: 1 finding(s), 0 defect(s)\n`);
    expect(requests).toBe(0);
  });
});

describe('pageText', () => {
  const convert = loadConverter();
  if (!convert) throw new Error('turndown must resolve from the package');

  it('drops script and style bodies and folds curly quotes and dashes', () => {
    expect(
      pageText(
        '<style>b{}</style><p>It&rsquo;s  A\u2014B</p><script>x</script>',
        'text/html',
        convert,
      ),
    ).toBe("it's a-b");
  });

  it('joins text across inline tags without adding a space before punctuation', () => {
    expect(
      pageText(
        '<p>Call <code>x</code>. Then <b>stop</b>, now.</p>',
        'text/html',
        convert,
      ),
    ).toBe('call x. then stop, now.');
  });

  it('separates words across block elements', () => {
    expect(
      pageText(
        '<p>alpha</p><p>beta</p><ul><li>gamma</li></ul>',
        'text/html',
        convert,
      ),
    ).toBe('alpha beta gamma');
  });

  it('drops a footnote sup reference but keeps an exponent', () => {
    expect(
      pageText(
        '<p>a<sup><a href="#fn1">1</a></sup> b x<sup>2</sup></p>',
        'text/html',
        convert,
      ),
    ).toBe('a b x2');
  });

  it('replaces a LaTeXML math element with its alttext', () => {
    expect(
      pageText(
        '<p>so <math alttext="x^{2}"><mi>x</mi></math> holds</p>',
        'text/html',
        convert,
      ),
    ).toBe('so x^{2} holds');
  });

  it('strips U+200B and U+2061 to U+2064 from page text', () => {
    expect(pageText('a\u200bb\u2061c\u2064d', 'text/plain', convert)).toBe(
      'abcd',
    );
  });

  it('unwraps links and drops heading markers', () => {
    expect(
      pageText(
        '<h2>Title</h2><p>see <a href="/x">the docs</a></p>',
        'text/html',
        convert,
      ),
    ).toBe('title see the docs');
  });
});
