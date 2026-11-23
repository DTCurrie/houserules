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

  it('copies all three research agents', () => {
    const dests = actions.flatMap((a) => (a.kind === 'copy' ? [a.dest] : []));
    expect(dests).toEqual(
      expect.arrayContaining([
        '.claude/agents/research-spike.md',
        '.claude/agents/research-synth.md',
        '.claude/agents/research-orchestrator.md',
      ]),
    );
  });

  it('copies the refactor-planner agent', () => {
    const action = actions.find(
      (a) =>
        a.kind === 'copy' && a.dest === '.claude/agents/refactor-planner.md',
    );
    expect(action).toBeDefined();
  });

  it('copies the finding format doc under reference, not agents', () => {
    const action = actions.find(
      (a) => a.kind === 'copy' && a.dest.endsWith('findings-format.md'),
    );
    expect(action).toMatchObject({
      dest: '.claude/reference/findings-format.md',
    });
  });

  it('copies the check-findings script', () => {
    const action = actions.find(
      (a) =>
        a.kind === 'copy' && a.dest === '.claude/scripts/check-findings.mjs',
    );
    expect(action).toBeDefined();
  });

  it('copies the scaffold-synthesis script', () => {
    const action = actions.find(
      (a) =>
        a.kind === 'copy' &&
        a.dest === '.claude/scripts/scaffold-synthesis.mjs',
    );
    expect(action).toBeDefined();
  });

  it('copies the fetch-batch script', () => {
    const action = actions.find(
      (a) => a.kind === 'copy' && a.dest === '.claude/scripts/fetch-batch.mjs',
    );
    expect(action).toBeDefined();
  });

  it('copies the research layout reference under plan-project references', () => {
    const action = actions.find(
      (a) =>
        a.kind === 'copy' &&
        a.dest === '.claude/skills/plan-project/references/research-layout.md',
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
