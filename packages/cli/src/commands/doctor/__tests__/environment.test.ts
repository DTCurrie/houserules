import { describe, expect, it } from 'vitest';

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
      () => checkEnvironment(makeCtx(), { claudeVersion: '2.1.302' }).findings,
    );

    expect(findings).toContainEqual({
      level: 'ERROR',
      msg: 'node 18.0.0 < 20',
    });
  });

  it('does not error when the running node major meets the minimum', () => {
    const findings = withNodeMajor(
      20,
      () => checkEnvironment(makeCtx(), { claudeVersion: '2.1.302' }).findings,
    );

    expect(findings).toEqual([]);
  });

  it('errors when the target is not a git work tree', () => {
    const { findings } = checkEnvironment(
      makeCtx({
        git: { isRepo: false, top: null, hasCommits: false, branch: null },
      }),
      { claudeVersion: '2.1.302' },
    );

    expect(findings).toEqual([{ level: 'ERROR', msg: 'not a git work tree' }]);
  });

  it('does not report a git-tree error inside a git work tree', () => {
    const { findings } = checkEnvironment(makeCtx(), {
      claudeVersion: '2.1.302',
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
    expect(findings[0]?.msg).toContain('2.1.295');
    expect(findings[0]?.msg).toContain('2.1.270');
  });

  it('is silent and reads out the floor when the running version meets every gate', () => {
    const { findings, readouts } = checkEnvironment(makeCtx(), {
      claudeVersion: '2.1.302',
    });

    expect(findings).toEqual([]);
    expect(readouts).toEqual(['claude 2.1.302 (floor 2.1.295)']);
  });

  it('warns at 2.1.299 when orchestrate is installed with a server-level worker tool', () => {
    const { findings } = checkEnvironment(
      withInstall(['core', 'orchestrate'], ['mcp__svelte']),
      { claudeVersion: '2.1.293' },
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.msg).toContain('2.1.299');
  });

  it('warns at 2.1.295 when orchestrate is absent and no worker tool needs 2.1.299', () => {
    const { findings } = checkEnvironment(withInstall(['core']), {
      claudeVersion: '2.1.293',
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.msg).toContain('2.1.295');
  });

  it('compares segments numerically, so 2.1.1000 passes a 2.1.295 gate', () => {
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
      'INFO claude binary not found on PATH (floor 2.1.295)',
    ]);
  });
});
