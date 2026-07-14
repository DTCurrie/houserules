import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli } from './fixtures.mjs';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('SW1: sweep module ships the /sweep skill (opt-in); off by default', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    // Off by default.
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    assert.ok(!existsSync(join(root, '.claude/skills/sweep/SKILL.md')));

    // Enabled → skill lands, describing the O(shards) discipline.
    assert.equal(runCli(['init', '--yes', '--modules=sweep', root]).status, 0);
    const skillPath = join(root, '.claude/skills/sweep/SKILL.md');
    assert.ok(existsSync(skillPath));
    const text = readFileSync(skillPath, 'utf8');
    assert.match(text, /O\(shards\)/);
    assert.match(text, /haiku|effort: low/);
    assert.equal(runCli(['doctor', root]).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PA1: persona-auditor stages its template only when enabled; core never stages it', () => {
  const root = makeFixture('pnpm-monorepo');
  const tmpl = '.claude/kit-templates/agents/persona-auditor.agent.md.template';
  try {
    // Default init: reviewer template lands, persona-auditor does NOT (module-owned).
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    assert.ok(
      existsSync(
        join(root, '.claude/kit-templates/agents/reviewer.agent.md.template'),
      ),
    );
    assert.ok(!existsSync(join(root, tmpl)), 'persona-auditor off by default');

    // Enabled → the template stages, with the anti-anchoring discipline prominent.
    assert.equal(
      runCli(['init', '--yes', '--modules=persona-auditor', root]).status,
      0,
    );
    assert.ok(existsSync(join(root, tmpl)));
    const text = readFileSync(join(root, tmpl), 'utf8');
    assert.match(text, /DO NOT ANCHOR|anti-anchor/i);
    assert.match(text, /blindRanking/);
    assert.match(text, /model: haiku/);
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    assert.ok(manifest.modules.includes('persona-auditor'));
    assert.equal(runCli(['doctor', root]).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('BR1: plans module also ships the /blast-radius worked-example skill', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', '--modules=plans', root]).status, 0);
    const skillPath = join(root, '.claude/skills/blast-radius/SKILL.md');
    assert.ok(
      existsSync(skillPath),
      '/blast-radius skill installed with plans',
    );
    const text = readFileSync(skillPath, 'utf8');
    assert.match(text, /\.claude\/plans\/blast-radius-/);
    assert.match(text, /disclaimer|Snapshot at commit/i);
    assert.match(text, /Completeness self-audit/);
    // plan-project still lands too.
    assert.ok(existsSync(join(root, '.claude/skills/plan-project/SKILL.md')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
