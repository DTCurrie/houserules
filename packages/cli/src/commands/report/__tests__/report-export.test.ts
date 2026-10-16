import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { HouseError } from '../../../house-error.js';
import {
  buildReportDocument,
  type ReportDocument,
} from '../report-document.js';
import {
  readImportFiles,
  redactDocument,
  writeExportFile,
} from '../report-export.js';
import { emptyCorpus, ingestTranscript } from '../transcript-events.js';

const SECRET_PATH = '/Users/someone/work/secret.ts';

function bashUse(id: string, command: string): unknown {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
  };
}

function hookFire(
  toolUseID: string,
  exitCode: number,
  stderr: string,
): unknown {
  return {
    type: 'attachment',
    attachment: {
      hookName: 'PreToolUse:Bash',
      exitCode,
      stderr,
      toolUseID,
    },
  };
}

function denial(toolUseId: string): unknown {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: "The user doesn't want to proceed with this tool use",
        },
      ],
    },
  };
}

function buildFixture(): ReportDocument {
  const corpus = emptyCorpus(['slug']);
  const records = [
    bashUse('t1', 'git push origin main'),
    bashUse('t2', 'git push origin main'),
    hookFire('t1', 2, 'blocked by policy'),
    hookFire(
      't1',
      1,
      `Error: Cannot find module '/Users/someone/work/hook-lib.mjs'`,
    ),
    hookFire('t1', 1, `throw err at ${SECRET_PATH}`),
    bashUse('t3', `rm -rf ${SECRET_PATH}`),
    denial('t3'),
  ];
  ingestTranscript(
    corpus,
    'sess-abcdef12.jsonl',
    records.map((record) => JSON.stringify(record)).join('\n'),
  );
  const root = mkdtempSync(join(tmpdir(), 'report-export-root-'));
  return buildReportDocument(corpus, root, {
    label: 'work',
    cliVersion: '0.7.0',
    now: new Date('2026-10-16T00:00:00Z'),
  });
}

describe('redactDocument', () => {
  let original: ReportDocument;
  let snapshot: string;
  let redacted: ReportDocument;

  beforeAll(() => {
    original = buildFixture();
    snapshot = JSON.stringify(original);
    redacted = redactDocument(original);
  });

  it('seeds a guard block, a denial, a retry run, and a crash signature in the fixture', () => {
    expect(original.guard.map((block) => block.blockedCommand)).toEqual([
      'git push origin main',
    ]);
    expect(original.friction.denials[0]?.command).toBe(`rm -rf ${SECRET_PATH}`);
    expect(original.friction.retryRuns[0]?.command).toBe(
      'git push origin main',
    );
    expect(original.hooks.crashSignatures.length).toBeGreaterThan(0);
  });

  it('removes paths, file names, and command arguments', () => {
    const text = JSON.stringify(redacted);

    expect(text).not.toContain('/Users/');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('origin main');
  });

  it('keeps the git subcommand as the command family', () => {
    expect(redacted.guard).toEqual([
      { session: 'sess-abc', blockedCommand: 'git push' },
    ]);
    expect(redacted.friction.retryRuns[0]?.command).toBe('git push');
  });

  it('reduces a non-git command to its first token', () => {
    expect(redacted.friction.denials).toEqual([
      { tool: 'Bash', command: 'rm' },
    ]);
  });

  it('keeps a missing-module signature as its basename and redacts any other', () => {
    expect(redacted.hooks.crashSignatures).toEqual([
      { signature: "Cannot find module 'hook-lib.mjs'", count: 1 },
      { signature: 'stderr line (redacted)', count: 1 },
    ]);
  });

  it('leaves hook rows, bulk, tokens, and meta unchanged', () => {
    expect(redacted.hooks.rows).toEqual(original.hooks.rows);
    expect(redacted.friction.bulkByTool).toEqual(original.friction.bulkByTool);
    expect(redacted.tokens).toEqual(original.tokens);
    expect(redacted.meta).toEqual(original.meta);
  });

  it('does not mutate its input', () => {
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe('writeExportFile and readImportFiles', () => {
  it('round-trips a document through a nested path', () => {
    const document = buildFixture();
    const path = join(
      mkdtempSync(join(tmpdir(), 'report-export-')),
      'a',
      'b',
      'out.json',
    );

    writeExportFile(path, document);

    expect(readImportFiles([path])).toEqual([
      JSON.parse(JSON.stringify(document)),
    ]);
  });

  it('throws a HouseError naming the path when the file is not a report document', () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-export-'));
    const path = join(dir, 'nope.json');
    writeFileSync(path, '{"nope":1}');

    expect(() => readImportFiles([path])).toThrow(HouseError);
    expect(() => readImportFiles([path])).toThrow(path);
  });

  it('throws a HouseError naming the path when the file is not JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-export-'));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'broken.json');
    writeFileSync(path, 'not json');

    expect(() => readImportFiles([path])).toThrow(path);
  });

  it('throws a HouseError naming the path when the file is missing', () => {
    const path = join(tmpdir(), 'report-export-missing', 'gone.json');

    expect(() => readImportFiles([path])).toThrow(HouseError);
    expect(() => readImportFiles([path])).toThrow(path);
  });
});
