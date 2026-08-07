import { beforeEach, describe, expect, it } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

const LOG = '.claude/scripts/decision-log.mjs';
const LEDGER = '.claude/ledgers/decisions.jsonl';
const SURFACE = '.claude/ledgers/DECISIONS.md';
const PLUGIN_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function installDecisions(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'decisions/decisions',
    plugins: [{ name: PLUGIN_ROOT, alias: 'decisions' }],
  });
}

interface LogRecord {
  ts: string;
  id: string;
  action: string;
  file?: string;
  title?: string;
  supersedes?: string[];
  under?: string;
  scope?: string[];
  chat: string | null;
  content?: string;
}

function run(root: string, args: string[], input = '') {
  return runScript(root, LOG, { args, input });
}

function readFile(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

function writeFile(root: string, rel: string, body: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function logRecords(root: string): LogRecord[] {
  return readFile(root, LEDGER)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogRecord);
}

function encodeBody(body: string): string {
  return gzipSync(Buffer.from(body, 'utf8')).toString('base64');
}

function decodeBody(encoded: string): string {
  return gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
}

function seedLog(root: string, records: Partial<LogRecord>[]) {
  writeFile(
    root,
    LEDGER,
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
}

function seedLogAsCompleteHistory(root: string, records: Partial<LogRecord>[]) {
  rmSync(join(root, SURFACE), { force: true });
  seedLog(root, records);
}

describe('decision-log.mjs decide', () => {
  let root: string;

  beforeEach(() => {
    root = installDecisions();
  });

  it('prints a PREFIX-6hex id built from the prefix', () => {
    const r = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'chose navcat',
      '--chat=none',
    ]);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^SIM-[0-9a-f]{6}$/);
  });

  it('creates the surface file with a header naming the repo root', () => {
    run(root, ['decide', 'SIM', 'DECISIONS.md', 'T', 'B', '--chat=none']);

    expect(readFile(root, SURFACE)).toMatch(/^# Decisions — repo root\n/);
  });

  it('renders the entry with heading, decided date, status, and body', () => {
    const id = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'chose navcat',
      '--chat=none',
    ]).stdout.trim();

    const text = readFile(root, SURFACE);
    expect(text).toContain(`## [${id}] navcat over recast`);
    expect(text).toContain(
      `**Decided:** ${new Date().toISOString().slice(0, 10)} · **Status:** accepted`,
    );
    expect(text).toContain('chose navcat');
  });

  it('records a decide event carrying the gzipped body', () => {
    const id = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'chose navcat',
      '--chat=none',
    ]).stdout.trim();

    const [record] = logRecords(root);
    expect(record).toMatchObject({
      id,
      action: 'decide',
      file: 'DECISIONS.md',
      title: 'navcat over recast',
      chat: null,
    });
    expect(decodeBody(record.content!)).toBe('chose navcat');
  });

  it('carries --scope as an array of paths on the record', () => {
    run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'T',
      'B',
      '--scope',
      'src/sim/nav.ts,src/sim/agent.ts',
      '--chat=none',
    ]);

    expect(logRecords(root)[0].scope).toEqual([
      'src/sim/nav.ts',
      'src/sim/agent.ts',
    ]);
  });

  it('rejects an --under that does not resolve in the log', () => {
    const r = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'T',
      'B',
      '--under',
      'SIM-ffffff',
      '--chat=none',
    ]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SIM-ffffff does not resolve');
  });

  it('rejects an --supersedes that does not resolve in the log', () => {
    const r = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'T',
      'B',
      '--supersedes',
      'SIM-ffffff',
      '--chat=none',
    ]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SIM-ffffff does not resolve');
  });

  it('rejects a prefix that is not uppercase ASCII', () => {
    const r = run(root, [
      'decide',
      'lower',
      'DECISIONS.md',
      'T',
      'B',
      '--chat=none',
    ]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Invalid prefix "lower"');
  });

  it('rejects an empty body rather than logging a blank entry', () => {
    const r = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'T',
      '',
      '--chat=none',
    ]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Empty body');
  });
});

describe('decision-log.mjs decide, given an existing decision in the log', () => {
  let root: string;
  let firstId: string;

  beforeEach(() => {
    root = installDecisions();
    firstId = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'chose navcat',
      '--chat=none',
    ]).stdout.trim();
  });

  it('records the resolved --under id', () => {
    run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'nav mesh tiling',
      'body',
      '--under',
      firstId,
      '--chat=none',
    ]);

    expect(logRecords(root)[1]).toMatchObject({ under: firstId });
  });

  it('records the resolved --supersedes as an array, even with one id', () => {
    const secondId = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat revisited',
      'body',
      '--supersedes',
      firstId,
      '--chat=none',
    ]).stdout.trim();

    expect(logRecords(root)[1]).toMatchObject({
      id: secondId,
      supersedes: [firstId],
    });
  });

  it('marks the superseded id as superseded in the rendered surface', () => {
    run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat revisited',
      'body',
      '--supersedes',
      firstId,
      '--chat=none',
    ]);

    const text = readFile(root, SURFACE);
    const firstEntry = text.slice(text.indexOf(`[${firstId}]`));
    expect(firstEntry).toContain('**Status:** superseded');
  });

  it('rejects superseding an already-superseded id', () => {
    run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat revisited',
      'body',
      '--supersedes',
      firstId,
      '--chat=none',
    ]);

    const r = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat again',
      'body',
      '--supersedes',
      firstId,
      '--chat=none',
    ]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${firstId} is already superseded`);
  });
});

describe('decision-log.mjs supersede', () => {
  let root: string;
  let firstId: string;

  beforeEach(() => {
    root = installDecisions();
    firstId = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'chose navcat',
      '--chat=none',
    ]).stdout.trim();
  });

  it('mints a new id sharing the prefix of the superseded id', () => {
    const r = run(root, [
      'supersede',
      firstId,
      'DECISIONS.md',
      'navcat revisited',
      'switched to a hand-rolled navmesh',
      '--chat=none',
    ]);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^SIM-[0-9a-f]{6}$/);
    expect(r.stdout.trim()).not.toBe(firstId);
  });

  it('writes a supersedes array containing the target id', () => {
    run(root, [
      'supersede',
      firstId,
      'DECISIONS.md',
      'navcat revisited',
      'body',
      '--chat=none',
    ]);

    expect(logRecords(root)[1].supersedes).toEqual([firstId]);
  });

  it('shows the old entry as superseded and the new one as accepted', () => {
    const newId = run(root, [
      'supersede',
      firstId,
      'DECISIONS.md',
      'navcat revisited',
      'body',
      '--chat=none',
    ]).stdout.trim();

    const text = readFile(root, SURFACE);
    const oldEntry = text.slice(
      text.indexOf(`[${firstId}]`),
      text.indexOf(`[${newId}]`),
    );
    const newEntry = text.slice(text.indexOf(`[${newId}]`));
    expect(oldEntry).toContain('**Status:** superseded');
    expect(newEntry).toContain('**Status:** accepted');
  });

  it('rejects superseding an id that does not resolve in the log', () => {
    const r = run(root, [
      'supersede',
      'SIM-ffffff',
      'DECISIONS.md',
      'T',
      'B',
      '--chat=none',
    ]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SIM-ffffff does not resolve');
  });
});

describe('decision-log.mjs supersede, given a split and a merge', () => {
  let root: string;
  let originalId: string;

  beforeEach(() => {
    root = installDecisions();
    originalId = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'one big nav module',
      'body',
      '--chat=none',
    ]).stdout.trim();
  });

  it('renders a split as the original superseded and both children accepted', () => {
    seedLogAsCompleteHistory(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'SIM-aaaaaa',
        action: 'decide',
        file: 'DECISIONS.md',
        title: 'one big nav module',
        chat: null,
        content: encodeBody('body'),
      },
      {
        ts: '2026-01-02T00:00:00.000Z',
        id: 'SIM-bbbbbb',
        action: 'supersede',
        file: 'DECISIONS.md',
        title: 'nav pathing',
        supersedes: ['SIM-aaaaaa'],
        chat: null,
        content: encodeBody('body a'),
      },
      {
        ts: '2026-01-03T00:00:00.000Z',
        id: 'SIM-cccccc',
        action: 'supersede',
        file: 'DECISIONS.md',
        title: 'nav rendering',
        supersedes: ['SIM-aaaaaa'],
        chat: null,
        content: encodeBody('body b'),
      },
    ]);

    run(root, ['render', 'DECISIONS.md']);

    const text = readFile(root, SURFACE);
    const originalEntry = text.slice(
      text.indexOf('[SIM-aaaaaa]'),
      text.indexOf('[SIM-bbbbbb]'),
    );
    const childA = text.slice(
      text.indexOf('[SIM-bbbbbb]'),
      text.indexOf('[SIM-cccccc]'),
    );
    const childB = text.slice(text.indexOf('[SIM-cccccc]'));
    expect(originalEntry).toContain('**Status:** superseded');
    expect(childA).toContain('**Status:** accepted');
    expect(childB).toContain('**Status:** accepted');
  });

  it('merges two decisions by superseding both from one new record', () => {
    const otherId = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'a second decision',
      'body',
      '--chat=none',
    ]).stdout.trim();

    const mergedId = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'merged decision',
      'body',
      '--supersedes',
      `${originalId},${otherId}`,
      '--chat=none',
    ]).stdout.trim();

    expect(logRecords(root).find((r) => r.id === mergedId)?.supersedes).toEqual(
      [originalId, otherId],
    );
  });

  it('shows both merged sources as superseded after the merge', () => {
    const otherId = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'a second decision',
      'body',
      '--chat=none',
    ]).stdout.trim();
    const mergedId = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'merged decision',
      'body',
      '--supersedes',
      `${originalId},${otherId}`,
      '--chat=none',
    ]).stdout.trim();

    const text = readFile(root, SURFACE);
    const originalEntry = text.slice(
      text.indexOf(`[${originalId}]`),
      text.indexOf(`[${otherId}]`),
    );
    const otherEntry = text.slice(
      text.indexOf(`[${otherId}]`),
      text.indexOf(`[${mergedId}]`),
    );
    expect(originalEntry).toContain('**Status:** superseded');
    expect(otherEntry).toContain('**Status:** superseded');
  });
});

describe('decision-log.mjs amend', () => {
  let root: string;
  let id: string;

  beforeEach(() => {
    root = installDecisions();
    id = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'original body',
      '--chat=none',
    ]).stdout.trim();
  });

  it('folds the new body over the original in the rendered surface', () => {
    const r = run(root, [
      'amend',
      id,
      'DECISIONS.md',
      'clarified rationale',
      '--chat=none',
    ]);

    expect(r.status, r.stderr).toBe(0);
    const text = readFile(root, SURFACE);
    expect(text).toContain('clarified rationale');
    expect(text).not.toContain('original body');
  });

  it('leaves the title and status unchanged', () => {
    run(root, [
      'amend',
      id,
      'DECISIONS.md',
      'clarified rationale',
      '--chat=none',
    ]);

    const text = readFile(root, SURFACE);
    expect(text).toContain(`[${id}] navcat over recast`);
    expect(text).toContain('**Status:** accepted');
  });

  it('records an amend event with the same id and no edges', () => {
    run(root, [
      'amend',
      id,
      'DECISIONS.md',
      'clarified rationale',
      '--chat=none',
    ]);

    const [, amendRecord] = logRecords(root);
    expect(amendRecord).toMatchObject({ id, action: 'amend' });
    expect(amendRecord.supersedes).toBeUndefined();
    expect(amendRecord.under).toBeUndefined();
  });

  it('rejects amending an id that does not resolve in the log', () => {
    const r = run(root, [
      'amend',
      'SIM-ffffff',
      'DECISIONS.md',
      'body',
      '--chat=none',
    ]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SIM-ffffff does not resolve');
  });
});

describe('decision-log.mjs move', () => {
  const STUDIO_SURFACE = '.claude/ledgers/studio.DECISIONS.md';
  let root: string;
  let id: string;

  beforeEach(() => {
    root = installDecisions();
    id = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'chose navcat',
      '--chat=none',
    ]).stdout.trim();
  });

  it('renders the moved decision on the destination surface', () => {
    run(root, ['move', id, 'studio']);

    expect(readFile(root, STUDIO_SURFACE)).toContain(
      `[${id}] navcat over recast`,
    );
  });

  it('removes the decision from the source surface', () => {
    run(root, ['move', id, 'studio']);

    // The root area is not a configured target, so emptying it deletes the surface rather than
    // leaving a header-only stub that no later command could clear.
    expect(existsSync(join(root, SURFACE))).toBe(false);
  });

  it('keeps an emptied surface that belongs to a configured target', () => {
    run(root, ['move', id, 'studio']);
    run(root, ['move', id, 'cityville']);

    expect(existsSync(join(root, STUDIO_SURFACE))).toBe(true);
    expect(readFile(root, STUDIO_SURFACE)).not.toContain(id);
  });

  it('exits 1 when the id does not resolve in the log', () => {
    const r = run(root, ['move', 'SIM-ffffff', 'studio']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SIM-ffffff does not resolve');
  });

  it('keeps a supersede chain resolvable through ancestry after a member moves', () => {
    const secondId = run(root, [
      'supersede',
      id,
      'DECISIONS.md',
      'navcat revisited',
      'body',
      '--chat=none',
    ]).stdout.trim();

    run(root, ['move', id, 'studio']);
    const r = run(root, ['ancestry', secondId]);

    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toContain(`${secondId}  navcat revisited  accepted`);
    expect(lines[1]).toContain(`${id}  navcat over recast  superseded`);
  });
});

describe('decision-log.mjs rescope', () => {
  let root: string;
  let id: string;

  beforeEach(() => {
    root = installDecisions();
    id = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'chose navcat',
      '--scope',
      'src/render/nav.ts',
      '--chat=none',
    ]).stdout.trim();
  });

  function rescopeTo(scope: string) {
    return run(root, ['rescope', id, '--scope', scope, '--chat=none']);
  }

  it('finds the record under the path it was re-pointed to', () => {
    rescopeTo('src/design/nav.ts');

    const r = run(root, ['scope', 'src/design/nav.ts']);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(id);
  });

  it('stops finding the record under the path it was re-pointed away from', () => {
    rescopeTo('src/design/nav.ts');

    expect(run(root, ['scope', 'src/render/nav.ts']).stdout).not.toContain(id);
  });

  it('re-points every path at once when given a list', () => {
    rescopeTo('src/design/nav.ts,src/design/agent.ts');

    expect(run(root, ['scope', 'src/design/agent.ts']).stdout).toContain(id);
  });

  it('renders the new scope on the surface', () => {
    rescopeTo('src/design/nav.ts');

    expect(readFile(root, SURFACE)).toContain('**Scope:** `src/design/nav.ts`');
  });

  it('drops the old scope from the surface', () => {
    rescopeTo('src/design/nav.ts');

    expect(readFile(root, SURFACE)).not.toContain('src/render/nav.ts');
  });

  it('leaves the title and body unchanged', () => {
    rescopeTo('src/design/nav.ts');

    const text = readFile(root, SURFACE);
    expect(text).toContain(`[${id}] navcat over recast`);
    expect(text).toContain('chose navcat');
  });

  it('leaves the record accepted rather than superseding it', () => {
    rescopeTo('src/design/nav.ts');

    expect(readFile(root, SURFACE)).toContain('**Status:** accepted');
  });

  it('keeps the original decide event in the log beside the rescope event', () => {
    rescopeTo('src/design/nav.ts');

    const [decideRecord, rescopeRecord] = logRecords(root);
    expect(decideRecord).toMatchObject({
      action: 'decide',
      scope: ['src/render/nav.ts'],
    });
    expect(rescopeRecord).toMatchObject({
      id,
      action: 'rescope',
      scope: ['src/design/nav.ts'],
    });
  });

  it('records no body on the rescope event', () => {
    rescopeTo('src/design/nav.ts');

    expect(logRecords(root)[1].content).toBeUndefined();
  });

  it('shows the original scope and the new one as separate records', () => {
    rescopeTo('src/design/nav.ts');

    const r = run(root, ['show', id]);

    expect(r.stdout).toContain('scope: src/render/nav.ts');
    expect(r.stdout).toContain('scope: src/design/nav.ts');
  });

  it('exits 1 when the id does not resolve in the log', () => {
    const r = run(root, [
      'rescope',
      'SIM-ffffff',
      '--scope',
      'src/design/nav.ts',
      '--chat=none',
    ]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SIM-ffffff does not resolve');
  });

  it('exits 1 when no scope is given, rather than clearing the one recorded', () => {
    const r = run(root, ['rescope', id, '--chat=none']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage:');
  });
});

describe('decision-log.mjs rescope, given a decision recorded on an area surface', () => {
  const STUDIO_SURFACE = '.claude/ledgers/studio.DECISIONS.md';
  let root: string;
  let id: string;

  beforeEach(() => {
    root = installDecisions();
    id = run(root, [
      'decide',
      'SIM',
      'studio',
      'studio call',
      'body',
      '--scope',
      'apps/studio/render/nav.ts',
      '--chat=none',
    ]).stdout.trim();
  });

  it('renders the new scope onto the area surface the record already lives on', () => {
    run(root, [
      'rescope',
      id,
      '--scope',
      'apps/studio/design/nav.ts',
      '--chat=none',
    ]);

    expect(readFile(root, STUDIO_SURFACE)).toContain(
      '**Scope:** `apps/studio/design/nav.ts`',
    );
  });

  it('creates no repo-root surface for a record that never lived there', () => {
    run(root, [
      'rescope',
      id,
      '--scope',
      'apps/studio/design/nav.ts',
      '--chat=none',
    ]);

    expect(existsSync(join(root, SURFACE))).toBe(false);
  });
});

describe('decision-log.mjs scope, given a record whose scope path is gone from disk', () => {
  let root: string;
  let id: string;

  beforeEach(() => {
    root = installDecisions();
    id = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'body',
      '--scope',
      'src/render/nav.ts',
      '--chat=none',
    ]).stdout.trim();
  });

  it('names the record and the missing path', () => {
    const r = run(root, ['scope', 'src/design/nav.ts']);

    expect(r.stderr).toContain(`${id}  src/render/nav.ts`);
  });

  it('points at rescope as the repair', () => {
    const r = run(root, ['scope', 'src/design/nav.ts']);

    expect(r.stderr).toContain('rescope <id> --scope <path>,<path>');
  });

  it('exits 0, since the query itself succeeded', () => {
    expect(run(root, ['scope', 'src/design/nav.ts']).status).toBe(0);
  });

  it('warns even when the queried path matches nothing at all', () => {
    const r = run(root, ['scope', 'docs/unrelated.md']);

    expect(r.stdout.trim()).toBe('');
    expect(r.stderr).toContain(id);
  });

  it('goes quiet once the record is rescoped onto a path that exists', () => {
    writeFile(root, 'src/design/nav.ts', 'export {};\n');

    run(root, ['rescope', id, '--scope', 'src/design/nav.ts', '--chat=none']);

    expect(run(root, ['scope', 'src/design/nav.ts']).stderr).not.toContain(id);
  });

  it('omits a superseded record, whose scope describes the tree as it was', () => {
    run(root, [
      'supersede',
      id,
      'DECISIONS.md',
      'navcat revisited',
      'body',
      '--chat=none',
    ]);

    expect(run(root, ['scope', 'src/design/nav.ts']).stderr).not.toContain(id);
  });
});

describe('decision-log.mjs scope, given every scope path present on disk', () => {
  let root: string;

  beforeEach(() => {
    root = installDecisions();
    writeFile(root, 'src/render/nav.ts', 'export {};\n');
    run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'body',
      '--scope',
      'src/render/nav.ts',
      '--chat=none',
    ]);
  });

  it('emits no stale-scope warning', () => {
    expect(run(root, ['scope', 'src/render/nav.ts']).stderr).not.toContain(
      'warning:',
    );
  });

  it('matches a directory scope whose directory exists', () => {
    const id = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'render layout',
      'body',
      '--scope',
      'src/render',
      '--chat=none',
    ]).stdout.trim();

    const r = run(root, ['scope', 'src/render/nav.ts']);

    expect(r.stdout).toContain(id);
    expect(r.stderr).not.toContain('warning:');
  });
});

describe('decision-log.mjs show', () => {
  let root: string;

  beforeEach(() => {
    root = installDecisions();
  });

  it('decodes the stored body for the requested id', () => {
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'SIM-aaaaaa',
        action: 'decide',
        file: 'DECISIONS.md',
        title: 'navcat over recast',
        chat: 'session-42',
        content: encodeBody('chose navcat'),
      },
    ]);

    const r = run(root, ['show', 'SIM-aaaaaa']);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('chose navcat');
    expect(r.stdout).toContain('chat: session-42');
  });

  it('prints every record for the id in log order, decide then amend', () => {
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'SIM-aaaaaa',
        action: 'decide',
        title: 'navcat over recast',
        chat: null,
        content: encodeBody('first body'),
      },
      {
        ts: '2026-01-02T00:00:00.000Z',
        id: 'SIM-aaaaaa',
        action: 'amend',
        chat: null,
        content: encodeBody('second body'),
      },
    ]);

    const r = run(root, ['show', 'SIM-aaaaaa']);

    expect(r.stdout.indexOf('first body')).toBeLessThan(
      r.stdout.indexOf('second body'),
    );
  });

  it('prints the supersedes ids for a supersede record', () => {
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'SIM-bbbbbb',
        action: 'supersede',
        title: 'revisited',
        supersedes: ['SIM-aaaaaa'],
        chat: null,
        content: encodeBody('body'),
      },
    ]);

    expect(run(root, ['show', 'SIM-bbbbbb']).stdout).toContain(
      'supersedes: SIM-aaaaaa',
    );
  });

  it('exits 1 when the id has no records', () => {
    seedLog(root, []);

    const r = run(root, ['show', 'SIM-aaaaaa']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('No log entries for SIM-aaaaaa');
  });

  it('exits 0 when no log exists yet, since an empty ledger is not an error', () => {
    const r = run(root, ['show', 'SIM-aaaaaa']);

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('No decision log yet');
  });
});

describe('decision-log.mjs list', () => {
  let root: string;

  beforeEach(() => {
    root = installDecisions();
  });

  it('prints each entry as id, date, status, and title', () => {
    const id = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'body',
      '--chat=none',
    ]).stdout.trim();

    const r = run(root, ['list', 'DECISIONS.md']);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      `${id}  ${new Date().toISOString().slice(0, 10)}  accepted  navcat over recast`,
    );
  });

  it('shows superseded status for a superseded entry', () => {
    const id = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'body',
      '--chat=none',
    ]).stdout.trim();
    run(root, [
      'supersede',
      id,
      'DECISIONS.md',
      'navcat revisited',
      'body',
      '--chat=none',
    ]);

    const r = run(root, ['list', 'DECISIONS.md']);

    expect(r.stdout).toContain(`${id}  `);
    expect(r.stdout.split('\n').find((line) => line.includes(id))).toContain(
      'superseded',
    );
  });

  it('reports a live entry from a migrated ledger with no rendered surface on disk', () => {
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'SIM-aaaaaa',
        action: 'decide',
        file: 'games/cityville/DECISIONS.md',
        title: 'Old-style decision',
        chat: null,
        content: encodeBody('body'),
      },
    ]);

    const r = run(root, ['list']);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('SIM-aaaaaa');
    expect(r.stdout).toContain('Old-style decision');
  });
});

describe('decision-log.mjs render', () => {
  let root: string;

  beforeEach(() => {
    root = installDecisions();
  });

  it('rebuilds the surface from the log alone', () => {
    run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'chose navcat',
      '--chat=none',
    ]);
    writeFile(root, SURFACE, 'corrupted by hand\n');

    const r = run(root, ['render', 'DECISIONS.md']);

    expect(r.status, r.stderr).toBe(0);
    const text = readFile(root, SURFACE);
    expect(text).toContain('chose navcat');
    expect(text).not.toContain('corrupted by hand');
  });
});

describe('decision-log.mjs ancestry', () => {
  let root: string;
  let firstId: string;
  let secondId: string;

  beforeEach(() => {
    root = installDecisions();
    firstId = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'chose navcat',
      '--chat=none',
    ]).stdout.trim();
    secondId = run(root, [
      'supersede',
      firstId,
      'DECISIONS.md',
      'navcat revisited',
      'body',
      '--chat=none',
    ]).stdout.trim();
  });

  it('walks the supersedes chain upward from the given id', () => {
    const r = run(root, ['ancestry', secondId]);

    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toContain(`${secondId}  navcat revisited  accepted`);
    expect(lines[1]).toContain(`${firstId}  navcat over recast  superseded`);
  });

  it('indents an ancestor deeper than the record it walked from', () => {
    const r = run(root, ['ancestry', secondId]);

    const lines = r.stdout.trim().split('\n');
    expect(lines[1].startsWith('  ')).toBe(true);
  });

  it('prints no body for any node in the walk', () => {
    const r = run(root, ['ancestry', secondId]);

    expect(r.stdout).not.toContain('chose navcat');
  });

  it('rejects an id that does not resolve in the log', () => {
    const r = run(root, ['ancestry', 'SIM-ffffff']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SIM-ffffff does not resolve');
  });
});

describe('decision-log.mjs ancestry, given a merge', () => {
  let root: string;

  beforeEach(() => {
    root = installDecisions();
  });

  it('prints both merged sources when a record supersedes two ids', () => {
    const firstId = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'body',
      '--chat=none',
    ]).stdout.trim();
    const otherId = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'a second decision',
      'body',
      '--chat=none',
    ]).stdout.trim();
    const mergedId = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'merged decision',
      'body',
      '--supersedes',
      `${firstId},${otherId}`,
      '--chat=none',
    ]).stdout.trim();

    const r = run(root, ['ancestry', mergedId]);

    expect(r.stdout).toContain(firstId);
    expect(r.stdout).toContain(otherId);
  });
});

describe('decision-log.mjs current', () => {
  let root: string;
  let firstId: string;
  let secondId: string;

  beforeEach(() => {
    root = installDecisions();
    firstId = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'chose navcat',
      '--chat=none',
    ]).stdout.trim();
    secondId = run(root, [
      'supersede',
      firstId,
      'DECISIONS.md',
      'navcat revisited',
      'body',
      '--chat=none',
    ]).stdout.trim();
  });

  it('walks the superseded-by chain downward to what replaces the record now', () => {
    const r = run(root, ['current', firstId]);

    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toContain(`${firstId}  navcat over recast  superseded`);
    expect(lines[1]).toContain(`${secondId}  navcat revisited  accepted`);
  });

  it('prints an accepted record with itself as the only line', () => {
    const r = run(root, ['current', secondId]);

    expect(r.stdout.trim()).toBe(`${secondId}  navcat revisited  accepted`);
  });

  it('prints no body for any node in the walk', () => {
    const r = run(root, ['current', firstId]);

    expect(r.stdout).not.toContain('chose navcat');
  });
});

describe('decision-log.mjs tree', () => {
  let root: string;
  let parentId: string;
  let childId: string;

  beforeEach(() => {
    root = installDecisions();
    parentId = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navigation architecture',
      'body',
      '--chat=none',
    ]).stdout.trim();
    childId = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'body',
      '--under',
      parentId,
      '--chat=none',
    ]).stdout.trim();
  });

  it('walks the under-children index down from the given id', () => {
    const r = run(root, ['tree', parentId]);

    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toContain(
      `${parentId}  navigation architecture  accepted`,
    );
    expect(lines[1]).toContain(`${childId}  navcat over recast  accepted`);
  });

  it('indents a child deeper than its parent', () => {
    const r = run(root, ['tree', parentId]);

    const lines = r.stdout.trim().split('\n');
    expect(lines[1].startsWith('  ')).toBe(true);
  });

  it('prints only the given id when it has no children', () => {
    const r = run(root, ['tree', childId]);

    expect(r.stdout.trim()).toBe(`${childId}  navcat over recast  accepted`);
  });

  it('prints no body for any node in the walk', () => {
    const r = run(root, ['tree', parentId]);

    expect(r.stdout).not.toContain('body');
  });
});

describe('decision-log.mjs scope', () => {
  let root: string;

  beforeEach(() => {
    root = installDecisions();
  });

  function decideScoped(root: string, scope: string): string {
    return run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'scoped decision',
      'body',
      '--scope',
      scope,
      '--chat=none',
    ]).stdout.trim();
  }

  it('finds a decision scoped to a directory when asked about a file inside it', () => {
    const id = decideScoped(root, 'src/sim');

    const r = run(root, ['scope', 'src/sim/nav.ts']);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(id);
  });

  it('finds a decision scoped to a file when asked about the directory holding it', () => {
    const id = decideScoped(root, 'src/sim/nav.ts');

    const r = run(root, ['scope', 'src/sim']);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(id);
  });

  it('does not match a sibling directory sharing a name prefix', () => {
    const id = decideScoped(root, 'src/sim');

    const r = run(root, ['scope', 'src/simulator']);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain(id);
  });

  it('ignores a trailing slash on the queried path', () => {
    const id = decideScoped(root, 'src/sim');

    const r = run(root, ['scope', 'src/sim/']);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(id);
  });

  it('prints records whose scope includes any of the given paths', () => {
    const id = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'chose navcat',
      '--scope',
      'src/sim/nav.ts,src/sim/agent.ts',
      '--chat=none',
    ]).stdout.trim();

    const r = run(root, ['scope', 'src/sim/agent.ts']);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(`${id}  navcat over recast  accepted`);
  });

  it('omits a record whose scope does not include any of the given paths', () => {
    run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'chose navcat',
      '--scope',
      'src/sim/nav.ts',
      '--chat=none',
    ]);

    const r = run(root, ['scope', 'src/other/file.ts']);

    expect(r.stdout.trim()).toBe('');
  });
});

describe('decision-log.mjs render, given a superseded entry', () => {
  let root: string;

  beforeEach(() => {
    root = installDecisions();
  });

  it('adds a Superseded by line pointing at the record that replaced it', () => {
    const firstId = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'chose navcat',
      '--chat=none',
    ]).stdout.trim();
    const secondId = run(root, [
      'supersede',
      firstId,
      'DECISIONS.md',
      'navcat revisited',
      'body',
      '--chat=none',
    ]).stdout.trim();

    const text = readFile(root, SURFACE);
    const firstEntry = text.slice(
      text.indexOf(`[${firstId}]`),
      text.indexOf(`[${secondId}]`),
    );
    expect(firstEntry).toContain(`**Superseded by:** ${secondId}`);
  });

  it('omits the Superseded by line on an accepted entry', () => {
    run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'chose navcat',
      '--chat=none',
    ]);

    const text = readFile(root, SURFACE);
    expect(text).not.toContain('Superseded by');
  });
});

describe('decision-log.mjs given an area named as a path rather than a bare word', () => {
  const AREA_SURFACE = '.claude/ledgers/studio.DECISIONS.md';
  const AREA_PATH = 'apps/studio/DECISIONS.md';
  let root: string;

  beforeEach(() => {
    root = installDecisions();
    run(root, ['decide', 'SIM', 'studio', 'first call', 'body', '--chat=none']);
  });

  it('records the decision on the canonical area surface', () => {
    const id = run(root, [
      'decide',
      'SIM',
      AREA_PATH,
      'second call',
      'body',
      '--chat=none',
    ]).stdout.trim();

    expect(readFile(root, AREA_SURFACE)).toContain(id);
  });

  it('creates no surface at the path it was given', () => {
    run(root, [
      'decide',
      'SIM',
      AREA_PATH,
      'second call',
      'body',
      '--chat=none',
    ]);

    expect(existsSync(join(root, AREA_PATH))).toBe(false);
  });

  it('keeps the earlier decision on the surface it rewrites', () => {
    run(root, [
      'decide',
      'SIM',
      AREA_PATH,
      'second call',
      'body',
      '--chat=none',
    ]);

    expect(readFile(root, AREA_SURFACE)).toContain('first call');
  });

  it('records the decision against the canonical area, not the path', () => {
    run(root, [
      'decide',
      'SIM',
      AREA_PATH,
      'second call',
      'body',
      '--chat=none',
    ]);

    expect(logRecords(root).at(-1)?.file).toBe('studio.DECISIONS.md');
  });

  it('honors a path that names no surface as a literal write target', () => {
    mkdirSync(join(root, 'docs'), { recursive: true });

    run(root, [
      'decide',
      'SIM',
      'docs/calls.md',
      'loose call',
      'body',
      '--chat=none',
    ]);

    expect(existsSync(join(root, 'docs/calls.md'))).toBe(true);
  });
});

describe('decision-log.mjs given an area named by its own surface filename', () => {
  const AREA_SURFACE = '.claude/ledgers/studio.DECISIONS.md';
  const DOUBLED = '.claude/ledgers/studio.DECISIONS.md.DECISIONS.md';
  let root: string;

  beforeEach(() => {
    root = installDecisions();
    run(root, ['decide', 'SIM', 'studio', 'first call', 'body', '--chat=none']);
  });

  it('records the decision on the area surface', () => {
    const id = run(root, [
      'decide',
      'SIM',
      'studio.DECISIONS.md',
      'second call',
      'body',
      '--chat=none',
    ]).stdout.trim();

    expect(readFile(root, AREA_SURFACE)).toContain(id);
  });

  it('creates no surface carrying the basename twice', () => {
    run(root, [
      'decide',
      'SIM',
      'studio.DECISIONS.md',
      'second call',
      'body',
      '--chat=none',
    ]);

    expect(existsSync(join(root, DOUBLED))).toBe(false);
  });

  it('records the decision against the area, not the doubled name', () => {
    run(root, [
      'decide',
      'SIM',
      'studio.DECISIONS.md',
      'second call',
      'body',
      '--chat=none',
    ]);

    expect(logRecords(root).at(-1)?.file).toBe('studio.DECISIONS.md');
  });
});

describe('decision-log.mjs given a ledger already carrying doubled surface names', () => {
  const AREA_SURFACE = '.claude/ledgers/studio.DECISIONS.md';
  const DOUBLED = '.claude/ledgers/studio.DECISIONS.md.DECISIONS.md';
  let root: string;

  beforeEach(() => {
    root = installDecisions();
    seedLogAsCompleteHistory(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'SIM-aaaaaa',
        action: 'decide',
        file: 'studio.DECISIONS.md',
        title: 'Recorded correctly',
        chat: null,
        content: encodeBody('body one'),
      },
      {
        ts: '2026-01-02T00:00:00.000Z',
        id: 'SIM-bbbbbb',
        action: 'decide',
        file: 'studio.DECISIONS.md.DECISIONS.md',
        title: 'Recorded with a doubled name',
        chat: null,
        content: encodeBody('body two'),
      },
    ]);
  });

  it('renders both records onto the one area surface', () => {
    run(root, ['render']);

    expect(readFile(root, AREA_SURFACE)).toContain(
      'Recorded with a doubled name',
    );
  });

  it('keeps the correctly recorded sibling on that surface', () => {
    run(root, ['render']);

    expect(readFile(root, AREA_SURFACE)).toContain('Recorded correctly');
  });

  it('renders no surface carrying the basename twice', () => {
    run(root, ['render']);

    expect(existsSync(join(root, DOUBLED))).toBe(false);
  });

  it('lists the recovered record under the area surface', () => {
    const r = run(root, ['list']);

    expect(r.stdout).not.toContain('.DECISIONS.md.DECISIONS.md');
  });

  it('does not rebuild a doubled surface already sitting on disk', () => {
    writeFile(root, DOUBLED, '# stale\n');

    run(root, ['render']);

    expect(readFile(root, DOUBLED)).toBe('# stale\n');
  });
});

describe('decision-log.mjs, given a configured ledgers.dir', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', {
      modules: 'decisions/decisions',
      plugins: [{ name: PLUGIN_ROOT, alias: 'decisions' }],
      config: { ledgers: { dir: 'custom-ledgers' } },
    });
  });

  it('writes the ledger and renders the surface under the configured directory', () => {
    const id = run(root, [
      'decide',
      'SIM',
      'DECISIONS.md',
      'navcat over recast',
      'chose navcat',
      '--chat=none',
    ]).stdout.trim();

    expect(
      readFileSync(join(root, 'custom-ledgers/decisions.jsonl'), 'utf8'),
    ).toContain(id);
    expect(
      readFileSync(join(root, 'custom-ledgers/DECISIONS.md'), 'utf8'),
    ).toContain(`[${id}]`);
  });
});

describe('decision-log.mjs render, given a ledger written before the ledger-directory move', () => {
  let root: string;

  beforeEach(() => {
    root = installDecisions();
  });

  it('renders a record whose file field is a repo-relative target path at the target surface', () => {
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'SIM-aaaaaa',
        action: 'decide',
        file: 'games/cityville/DECISIONS.md',
        title: 'Old-style decision',
        chat: null,
        content: encodeBody('body'),
      },
    ]);

    run(root, ['render', 'cityville']);

    expect(readFile(root, '.claude/ledgers/cityville.DECISIONS.md')).toContain(
      '[SIM-aaaaaa] Old-style decision',
    );
  });

  it('renders a mix of old-style and new-style entries for the same area together', () => {
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'SIM-aaaaaa',
        action: 'decide',
        file: 'games/cityville/DECISIONS.md',
        title: 'Old-style decision',
        chat: null,
        content: encodeBody('body one'),
      },
      {
        ts: '2026-01-02T00:00:00.000Z',
        id: 'SIM-bbbbbb',
        action: 'decide',
        file: 'cityville.DECISIONS.md',
        title: 'New-style decision',
        chat: null,
        content: encodeBody('body two'),
      },
    ]);

    run(root, ['render', 'cityville']);

    const surface = readFile(root, '.claude/ledgers/cityville.DECISIONS.md');
    expect(surface).toContain('[SIM-aaaaaa] Old-style decision');
    expect(surface).toContain('[SIM-bbbbbb] New-style decision');
  });

  it('does not bleed an old-style entry from one target into a sibling target surface', () => {
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'SIM-aaaaaa',
        action: 'decide',
        file: 'games/cityville/DECISIONS.md',
        title: 'Cityville decision',
        chat: null,
        content: encodeBody('body'),
      },
    ]);

    run(root, ['render', 'studio']);

    expect(readFile(root, '.claude/ledgers/studio.DECISIONS.md')).not.toContain(
      'Cityville decision',
    );
  });

  it('falls back to the trailing directory name for an area the config no longer lists', () => {
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'SIM-aaaaaa',
        action: 'decide',
        file: 'packages/retired-area/DECISIONS.md',
        title: 'Orphaned decision',
        chat: null,
        content: encodeBody('body'),
      },
    ]);

    run(root, ['render', 'retired-area']);

    expect(
      readFile(root, '.claude/ledgers/retired-area.DECISIONS.md'),
    ).toContain('[SIM-aaaaaa] Orphaned decision');
  });

  it('writes every surface the migrated ledger implies when render is given no argument', () => {
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'SIM-aaaaaa',
        action: 'decide',
        file: 'games/cityville/DECISIONS.md',
        title: 'Cityville decision',
        chat: null,
        content: encodeBody('body one'),
      },
      {
        ts: '2026-01-02T00:00:00.000Z',
        id: 'SIM-bbbbbb',
        action: 'decide',
        file: 'apps/studio/DECISIONS.md',
        title: 'Studio decision',
        chat: null,
        content: encodeBody('body two'),
      },
    ]);

    const r = run(root, ['render']);

    expect(r.status, r.stderr).toBe(0);
    expect(readFile(root, '.claude/ledgers/cityville.DECISIONS.md')).toContain(
      '[SIM-aaaaaa] Cityville decision',
    );
    expect(readFile(root, '.claude/ledgers/studio.DECISIONS.md')).toContain(
      '[SIM-bbbbbb] Studio decision',
    );
  });
});

describe('decision-log.mjs with no recognized action', () => {
  let root: string;

  beforeEach(() => {
    root = installDecisions();
  });

  it('exits 1 on an unknown action', () => {
    const r = run(root, ['frobnicate']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage:');
  });

  it('exits 0 when invoked with no arguments at all', () => {
    expect(run(root, []).status).toBe(0);
  });
});
