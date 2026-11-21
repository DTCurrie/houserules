import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkPlanProse,
  loadProseChecker,
  proseLintFiles,
  type ProseChecker,
} from '../plan-lint.mjs';

const STUB_CHECKER: ProseChecker = (file, markdown) => {
  const findings: ReturnType<ProseChecker>['findings'] = [];
  markdown.split('\n').forEach((line, index) => {
    if (line.includes(';')) {
      findings.push({
        rule: 'prose-voice/semicolon',
        level: 'error',
        file,
        line: index + 1,
        msg: 'semicolon',
      });
    }
    if (line.includes('—')) {
      findings.push({
        rule: 'prose-voice/em-dash',
        level: 'warn',
        file,
        line: index + 1,
        msg: 'em dash',
      });
    }
  });
  return { findings, declined: [] };
};

const STUB_PROSE_LINT = `export function checkProse(file, markdown) {
  return { findings: [], declined: [] };
}
`;

let root: string;
let plansDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plan-lint-prose-'));
  plansDir = join(root, '.claude/plans');
  mkdirSync(plansDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relativePath: string, content: string): string {
  const path = join(plansDir, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function roadmap(status: string): string {
  return `# ROADMAP\n\n**Status:** ${status}\n`;
}

function phase(status: string): string {
  return `# Phase\n\n**Status:** ${status}\n\nDo this; then that.\n`;
}

function relativeFiles(): string[] {
  return proseLintFiles(plansDir).map((file) => relative(plansDir, file));
}

describe('proseLintFiles', () => {
  it('lists PLAN.md, ROADMAP.md and an open phase file of an open workspace', () => {
    write('alpha/PLAN.md', '# plan\n');
    write('alpha/ROADMAP.md', roadmap('IN PROGRESS'));
    write('alpha/phase-1-one.md', phase('TODO'));
    expect(relativeFiles()).toEqual([
      'alpha/PLAN.md',
      'alpha/ROADMAP.md',
      'alpha/phase-1-one.md',
    ]);
  });

  it('skips a closed phase file but keeps an open one beside it', () => {
    write('alpha/ROADMAP.md', roadmap('IN PROGRESS'));
    write('alpha/phase-1-done.md', phase('DONE'));
    write('alpha/phase-2-dropped.md', phase('DROPPED'));
    write('alpha/phase-3-open.md', phase('TODO'));
    expect(relativeFiles()).toEqual([
      'alpha/ROADMAP.md',
      'alpha/phase-3-open.md',
    ]);
  });

  it('skips every file of a workspace whose ROADMAP is DONE or SUPERSEDED', () => {
    write('done/ROADMAP.md', roadmap('DONE'));
    write('done/phase-1-x.md', phase('TODO'));
    write('old/ROADMAP.md', roadmap('SUPERSEDED'));
    write('old/phase-1-x.md', phase('TODO'));
    expect(relativeFiles()).toEqual([]);
  });

  it('never reads below the workspace directory', () => {
    write('alpha/ROADMAP.md', roadmap('IN PROGRESS'));
    write('alpha/imports/phase-1-copy.md', phase('TODO'));
    write('alpha/reports/PLAN.md', 'a; b\n');
    expect(relativeFiles()).toEqual(['alpha/ROADMAP.md']);
  });

  it('reads a milestone member and the MILESTONE.md of an open milestone', () => {
    write('ms/MILESTONE.md', '# M\n\n**Status:** IN PROGRESS\n');
    write('ms/api/ROADMAP.md', roadmap('IN PROGRESS'));
    write('ms/api/phase-1-closed.md', phase('DONE'));
    write('ms/api/phase-2-open.md', phase('TODO'));
    expect(relativeFiles()).toEqual([
      'ms/MILESTONE.md',
      'ms/api/ROADMAP.md',
      'ms/api/phase-2-open.md',
    ]);
  });

  it('skips MILESTONE.md and every member of a DONE milestone', () => {
    write('ms/MILESTONE.md', '# M\n\n**Status:** DONE\n');
    write('ms/api/ROADMAP.md', roadmap('IN PROGRESS'));
    write('ms/api/phase-1-open.md', phase('TODO'));
    expect(relativeFiles()).toEqual([]);
  });
});

describe('checkPlanProse', () => {
  it('yields one error for an open phase with a semicolon, relative to root', () => {
    const file = write('alpha/phase-1-open.md', phase('TODO'));
    const report = checkPlanProse(root, [file], STUB_CHECKER);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      rule: 'prose-voice/semicolon',
      level: 'error',
      file: '.claude/plans/alpha/phase-1-open.md',
    });
  });

  it('keeps no warning, so a dash-only file yields nothing', () => {
    const file = write('alpha/PLAN.md', 'One — two.\n');
    expect(checkPlanProse(root, [file], STUB_CHECKER).findings).toEqual([]);
  });

  it('fails a milestone member open phase while its closed phases pass', () => {
    write('ms/MILESTONE.md', '# M\n\n**Status:** IN PROGRESS\n');
    write('ms/api/ROADMAP.md', roadmap('IN PROGRESS'));
    write('ms/api/phase-1-closed.md', phase('DONE'));
    write('ms/api/phase-2-open.md', phase('TODO'));
    const report = checkPlanProse(root, proseLintFiles(plansDir), STUB_CHECKER);
    expect(report.findings.map((finding) => finding.file)).toEqual([
      '.claude/plans/ms/api/phase-2-open.md',
    ]);
  });

  it('reports nothing for the same sentence in a DONE workspace', () => {
    write('done/ROADMAP.md', roadmap('DONE'));
    write('done/phase-1-x.md', phase('TODO'));
    const report = checkPlanProse(root, proseLintFiles(plansDir), STUB_CHECKER);
    expect(report.findings).toEqual([]);
  });
});

describe('loadProseChecker', () => {
  it('returns null with no prose-lint.mjs beside the script', async () => {
    const scriptsDir = mkdtempSync(join(tmpdir(), 'plan-lint-scripts-'));
    try {
      expect(await loadProseChecker(scriptsDir)).toBeNull();
    } finally {
      rmSync(scriptsDir, { recursive: true, force: true });
    }
  });

  it('returns null when prose-lint.mjs exports no checkProse function', async () => {
    const scriptsDir = mkdtempSync(join(tmpdir(), 'plan-lint-scripts-'));
    try {
      writeFileSync(
        join(scriptsDir, 'prose-lint.mjs'),
        'export const x = 1;\n',
      );
      expect(await loadProseChecker(scriptsDir)).toBeNull();
    } finally {
      rmSync(scriptsDir, { recursive: true, force: true });
    }
  });

  it('returns the exported checkProse when the file is present', async () => {
    const scriptsDir = mkdtempSync(join(tmpdir(), 'plan-lint-scripts-'));
    try {
      writeFileSync(join(scriptsDir, 'prose-lint.mjs'), STUB_PROSE_LINT);
      const checker = await loadProseChecker(scriptsDir);
      expect(checker).toBeTypeOf('function');
      expect(checker?.('a.md', 'x')).toEqual({ findings: [], declined: [] });
    } finally {
      rmSync(scriptsDir, { recursive: true, force: true });
    }
  });
});
