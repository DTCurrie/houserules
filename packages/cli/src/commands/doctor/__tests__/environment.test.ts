import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeCtx } from '#test/ctx-builder';
import type { Ctx } from '../../../detect.js';
import { checkEnvironment } from '../environment.js';

function withNodeMajor<T>(major: number, run: () => T): T {
  const original = process.versions;
  Object.defineProperty(process, 'versions', {
    value: { ...original, node: `${major}.0.0` },
    configurable: true,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'versions', {
      value: original,
      configurable: true,
    });
  }
}

describe('checkEnvironment', () => {
  it('errors when the running node major is below the minimum', () => {
    const findings = withNodeMajor(
      18,
      () => checkEnvironment(makeCtx(), { claudeVersion: '2.1.320' }).findings,
    );

    expect(findings).toContainEqual({
      level: 'ERROR',
      msg: 'node 18.0.0 < 20',
    });
  });

  it('does not error when the running node major meets the minimum', () => {
    const findings = withNodeMajor(
      20,
      () => checkEnvironment(makeCtx(), { claudeVersion: '2.1.320' }).findings,
    );

    expect(findings).toEqual([]);
  });

  it('errors when the target is not a git work tree', () => {
    const { findings } = checkEnvironment(
      makeCtx({
        git: { isRepo: false, top: null, hasCommits: false, branch: null },
      }),
      { claudeVersion: '2.1.320' },
    );

    expect(findings).toEqual([{ level: 'ERROR', msg: 'not a git work tree' }]);
  });

  it('does not report a git-tree error inside a git work tree', () => {
    const { findings } = checkEnvironment(makeCtx(), {
      claudeVersion: '2.1.320',
    });

    expect(findings).toEqual([]);
  });
});

function withInstall(modules: string[], workerTools?: string[]): Ctx {
  const base = makeCtx();
  return {
    ...base,
    claude: {
      ...base.claude,
      manifest: {
        kitVersion: '1.0.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        modules,
        files: {},
      },
      houseConfig: workerTools
        ? ({ version: 2, orchestrate: { workerTools } } as never)
        : null,
    },
  };
}

describe('checkEnvironment, Claude Code version gates', () => {
  it('warns at the highest always-on gate when the running version is below it', () => {
    const { findings } = checkEnvironment(makeCtx(), {
      claudeVersion: '2.1.270',
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe('WARN');
    expect(findings[0]?.msg).toContain('2.1.314');
    expect(findings[0]?.msg).toContain('2.1.270');
  });

  it('warns at 2.1.314 for a version that met the old 2.1.295 floor', () => {
    const { findings } = checkEnvironment(makeCtx(), {
      claudeVersion: '2.1.302',
    });

    expect(findings).toEqual([
      {
        level: 'WARN',
        msg: 'claude 2.1.302 < 2.1.314: guard-bash sees commands the Monitor tool starts. Update Claude Code',
      },
    ]);
  });

  it('is silent and reads out the floor when the running version meets every gate', () => {
    const { findings, readouts } = checkEnvironment(makeCtx(), {
      claudeVersion: '2.1.320',
    });

    expect(findings).toEqual([]);
    expect(readouts).toEqual(['claude 2.1.320 (floor 2.1.314)']);
  });

  it('keeps the 2.1.314 floor when orchestrate has a server-level worker tool, since 2.1.299 sits below it', () => {
    const { findings } = checkEnvironment(
      withInstall(['core', 'orchestrate'], ['mcp__svelte']),
      { claudeVersion: '2.1.293' },
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.msg).toContain('2.1.314');
  });

  it('compares segments numerically, so 2.1.1000 passes a 2.1.314 gate', () => {
    const { findings } = checkEnvironment(makeCtx(), {
      claudeVersion: '2.1.1000',
    });

    expect(findings).toEqual([]);
  });

  it('gives one INFO readout and no finding when the claude binary is missing', () => {
    const { findings, readouts } = checkEnvironment(makeCtx(), {
      claudeVersion: null,
    });

    expect(findings).toEqual([]);
    expect(readouts).toEqual([
      'INFO claude binary not found on PATH (floor 2.1.314)',
    ]);
  });
});

function withAgents(agents: Record<string, string>): Ctx {
  const root = mkdtempSync(join(tmpdir(), 'kit-env-agents-'));
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  for (const [name, body] of Object.entries(agents))
    writeFileSync(join(root, '.claude', 'agents', name), body);
  return makeCtx({ root });
}

describe('checkEnvironment, the Fable 5.2 gate', () => {
  it('warns at 2.1.321 when an installed agent pins model: fable', () => {
    const ctx = withAgents({
      'synth.md': '---\nname: synth\nmodel: fable\n---\n\nBody.\n',
    });

    const { findings } = checkEnvironment(ctx, { claudeVersion: '2.1.320' });

    expect(findings).toEqual([
      {
        level: 'WARN',
        msg: 'claude 2.1.320 < 2.1.321: an agent pins model: fable, which means Fable 5.2 only from this version. Update Claude Code',
      },
    ]);
  });

  it('reads out the 2.1.321 floor when a fable pin is quoted and the version meets it', () => {
    const ctx = withAgents({
      'synth.md': '---\nname: synth\nmodel: "fable"\n---\n',
    });

    const { readouts } = checkEnvironment(ctx, { claudeVersion: '2.1.321' });

    expect(readouts).toEqual(['claude 2.1.321 (floor 2.1.321)']);
  });

  it('keeps the 2.1.314 floor when every agent pins another model', () => {
    const ctx = withAgents({
      'worker.md': '---\nname: worker\nmodel: sonnet\n---\n',
      'notes.txt': 'model: fable\n',
    });

    const { readouts } = checkEnvironment(ctx, { claudeVersion: '2.1.320' });

    expect(readouts).toEqual(['claude 2.1.320 (floor 2.1.314)']);
  });

  it('ignores a model: fable line in an agent body below the frontmatter', () => {
    const ctx = withAgents({
      'worker.md': '---\nname: worker\nmodel: opus\n---\n\nmodel: fable\n',
    });

    const { readouts } = checkEnvironment(ctx, { claudeVersion: '2.1.320' });

    expect(readouts).toEqual(['claude 2.1.320 (floor 2.1.314)']);
  });
});
