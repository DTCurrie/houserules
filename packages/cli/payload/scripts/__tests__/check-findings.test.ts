import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { checkCovers, checkOrder } from '../check-findings.mjs';

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
