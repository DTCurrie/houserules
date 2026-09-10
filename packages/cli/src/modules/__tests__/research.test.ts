import { describe, expect, it } from 'vitest';

import { plan } from '../research.js';

describe('research module plan()', () => {
  const actions = plan();

  it('copies the research-spike agent', () => {
    const action = actions.find(
      (a) => a.kind === 'copy' && a.dest === '.claude/agents/research-spike.md',
    );
    expect(action).toBeDefined();
  });

  it('copies the research-synth agent', () => {
    const action = actions.find(
      (a) => a.kind === 'copy' && a.dest === '.claude/agents/research-synth.md',
    );
    expect(action).toBeDefined();
  });

  it('copies the refactor-planner agent', () => {
    const action = actions.find(
      (a) =>
        a.kind === 'copy' && a.dest === '.claude/agents/refactor-planner.md',
    );
    expect(action).toBeDefined();
  });

  it('advises how a planner dispatches these agents from a research phase', () => {
    const advise = actions.find((a) => a.kind === 'advise');
    expect(advise).toBeDefined();
    expect((advise as { text: string }).text).toMatch(/research-spike/);
    expect((advise as { text: string }).text).toMatch(/research-synth/);
    expect((advise as { text: string }).text).toMatch(/plan workspace/);
    expect((advise as { text: string }).text).toMatch(/refactor-planner/);
    expect((advise as { text: string }).text).toMatch(/\/orchestrate/);
  });
});
