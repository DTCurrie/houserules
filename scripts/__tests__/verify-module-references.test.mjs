import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findUndeclaredReferences,
  tokenForDest,
} from '../verify-module-references.mjs';

const SKILL_PATH = 'packages/cli/payload/skills/orchestrate/SKILL.md';

function sweepModule() {
  return {
    id: 'sweep',
    covers: [],
    tokens: ['/sweep', 'sweep-shard'],
    files: [],
  };
}

function orchestrateModule(text, covers = []) {
  return {
    id: 'orchestrate',
    covers,
    tokens: ['/orchestrate', '/plan-status'],
    files: [{ path: SKILL_PATH, text }],
  };
}

describe('findUndeclaredReferences, declarations', () => {
  const text = '# Orchestrate\n\nHand the wide pass to `/sweep`.\n';

  it('reports an undeclared skill mention with path, line, token, owner', () => {
    assert.deepEqual(
      findUndeclaredReferences([orchestrateModule(text), sweepModule()]),
      [
        {
          path: SKILL_PATH,
          line: 3,
          token: '/sweep',
          owner: 'sweep',
          module: 'orchestrate',
        },
      ],
    );
  });

  it('accepts the same mention when uses names the owner', () => {
    const uses = ['sweep'];
    assert.deepEqual(
      findUndeclaredReferences([orchestrateModule(text, uses), sweepModule()]),
      [],
    );
  });

  it('accepts the same mention when requires names the owner', () => {
    const requires = ['sweep'];
    assert.deepEqual(
      findUndeclaredReferences([
        orchestrateModule(text, requires),
        sweepModule(),
      ]),
      [],
    );
  });

  it('accepts a skill naming its own module’s other skill', () => {
    const ownText = 'Check progress with `/plan-status` first.\n';
    assert.deepEqual(
      findUndeclaredReferences([orchestrateModule(ownText), sweepModule()]),
      [],
    );
  });

  it('reports an agent mention by bare name', () => {
    const agentText = 'Dispatch a sweep-shard per directory.\n';
    assert.deepEqual(
      findUndeclaredReferences([orchestrateModule(agentText), sweepModule()]),
      [
        {
          path: SKILL_PATH,
          line: 1,
          token: 'sweep-shard',
          owner: 'sweep',
          module: 'orchestrate',
        },
      ],
    );
  });

  it('does not match a token embedded in a longer name or path', () => {
    const embedded =
      'See `.claude/skills/sweep/SKILL.md` and the `/sweeping` skill and sweep-shards.\n';
    assert.deepEqual(
      findUndeclaredReferences([orchestrateModule(embedded), sweepModule()]),
      [],
    );
  });
});

describe('findUndeclaredReferences, skipped regions', () => {
  const found = (line) => [
    {
      path: SKILL_PATH,
      line,
      token: '/sweep',
      owner: 'sweep',
      module: 'orchestrate',
    },
  ];

  it('skips a mention inside a fence', () => {
    const fenced = 'Intro.\n\n```text\nrun /sweep here\n```\n';
    assert.deepEqual(
      findUndeclaredReferences([orchestrateModule(fenced), sweepModule()]),
      [],
    );
  });

  it('reports the same mention unfenced', () => {
    const unfenced = 'Intro.\n\ntext\nrun /sweep here\n\n';
    assert.deepEqual(
      findUndeclaredReferences([orchestrateModule(unfenced), sweepModule()]),
      found(4),
    );
  });

  it('skips a mention in a block quote under a **Bad label', () => {
    const bad = '**Bad — names a skill:**\n\n> Then run /sweep.\n';
    assert.deepEqual(
      findUndeclaredReferences([orchestrateModule(bad), sweepModule()]),
      [],
    );
  });

  it('reports the same block quote under a **Good label', () => {
    const good = '**Good — names a skill:**\n\n> Then run /sweep.\n';
    assert.deepEqual(
      findUndeclaredReferences([orchestrateModule(good), sweepModule()]),
      found(3),
    );
  });

  it('skips a YAML comment inside frontmatter', () => {
    const comment =
      '---\nname: orchestrate\n# pairs with /sweep\ndescription: Runs a phase.\n---\n\nBody.\n';
    assert.deepEqual(
      findUndeclaredReferences([orchestrateModule(comment), sweepModule()]),
      [],
    );
  });

  it('reports the same mention on the frontmatter description line', () => {
    const description =
      '---\nname: orchestrate\ndescription: Runs a phase, pairs with /sweep\n---\n\nBody.\n';
    assert.deepEqual(
      findUndeclaredReferences([orchestrateModule(description), sweepModule()]),
      found(3),
    );
  });

  it('reports a heading line after frontmatter, which is not a YAML comment', () => {
    const heading = '---\nname: orchestrate\n---\n# pairs with /sweep\n';
    assert.deepEqual(
      findUndeclaredReferences([orchestrateModule(heading), sweepModule()]),
      found(4),
    );
  });
});

describe('tokenForDest', () => {
  it('maps each installed kind to its token', () => {
    assert.deepEqual(
      [
        '.claude/skills/ready/SKILL.md',
        '.claude/agents/research-spike.md',
        '.claude/scripts/plan-lint.mjs',
        '.claude/rules/testing.md',
        '.claude/reference/wcag22.md',
        '.claude/output-styles/kit-terse.md',
      ].map(tokenForDest),
      [
        '/ready',
        'research-spike',
        'plan-lint.mjs',
        'testing.md',
        'wcag22.md',
        'kit-terse.md',
      ],
    );
  });

  it('maps libs, skill references, and agent templates to nothing', () => {
    assert.deepEqual(
      [
        '.claude/scripts/lib/checker-input.mjs',
        '.claude/skills/orchestrate/references/slicing.md',
        '.claude/templates/agents/reviewer.agent.md.template',
        'CLAUDE.md',
      ].map(tokenForDest),
      [null, null, null, null],
    );
  });
});
