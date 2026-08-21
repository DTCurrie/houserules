import { describe, expect, it } from 'vitest';

import { makeCtx } from '#test/ctx-builder';
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
      () => checkEnvironment(makeCtx()).findings,
    );

    expect(findings).toContainEqual({
      level: 'ERROR',
      msg: 'node 18.0.0 < 20',
    });
  });

  it('does not error when the running node major meets the minimum', () => {
    const findings = withNodeMajor(
      20,
      () => checkEnvironment(makeCtx()).findings,
    );

    expect(findings).toEqual([]);
  });

  it('errors when the target is not a git work tree', () => {
    const { findings } = checkEnvironment(
      makeCtx({
        git: { isRepo: false, top: null, hasCommits: false, branch: null },
      }),
    );

    expect(findings).toEqual([{ level: 'ERROR', msg: 'not a git work tree' }]);
  });

  it('does not report a git-tree error inside a git work tree', () => {
    const { findings } = checkEnvironment(makeCtx());

    expect(findings).toEqual([]);
  });
});
