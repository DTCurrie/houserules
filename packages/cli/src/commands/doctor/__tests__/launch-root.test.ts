import { describe, expect, it } from 'vitest';

import { makeCtx } from '#test/ctx-builder';
import { checkLaunchRoot } from '../launch-root.js';

describe('checkLaunchRoot', () => {
  it('reports no findings when the install root is the git toplevel', () => {
    const ctx = makeCtx({
      root: '/repo',
      git: { isRepo: true, top: '/repo', hasCommits: true, branch: 'main' },
    });

    const { findings, readouts } = checkLaunchRoot('/repo', ctx);

    expect(findings).toEqual([]);
    expect(readouts).toEqual([]);
  });

  it('warns once when the install root sits one level below the git toplevel', () => {
    const ctx = makeCtx({
      root: '/repo/sub',
      git: { isRepo: true, top: '/repo', hasCommits: true, branch: 'main' },
    });

    const { findings } = checkLaunchRoot('/repo/sub', ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.msg).toContain(
      'a session launched outside /repo/sub runs without houserules hooks',
    );
  });

  it('reports no findings and does not throw outside a git repo', () => {
    const ctx = makeCtx({
      root: '/repo',
      git: { isRepo: false, top: null, hasCommits: false, branch: null },
    });

    const { findings } = checkLaunchRoot('/repo', ctx);

    expect(findings).toEqual([]);
  });
});
