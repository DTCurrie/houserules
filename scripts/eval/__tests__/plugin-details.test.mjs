import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDetails } from '../fixtures/skill-routing/plugin-details.mjs';

const REAL_OUTPUT = `houserules-skill-routing 0.0.0
  Description: Skill-routing eval target
  Source: houserules-skill-routing@inline

Component inventory
  Skills (19)  accessibility-review, backlog-add, backlog-adopt, blast-radius, changeset, chrome-devtools-mode, debug-session, decide, design-review, ledger-sync, orchestrate, plan-project, pr-description, ready, review-change, sweep, tidy, verify-changed, wireit-setup
  Agents (0)
  Hooks (0)

Projected token cost
  Always-on:   ~1,683 tok   added to every session

Per-component (rounded)
  component             always-on  on-invoke
  ready                      ~110      ~1.5k
`;

test('parseDetails reads the always-on figure, thousands separator included', () => {
  assert.deepEqual(parseDetails(REAL_OUTPUT), {
    alwaysOnTokens: 1683,
    skillCount: 19,
  });
});

test('parseDetails throws when the always-on line is missing', () => {
  assert.throws(() => parseDetails('Skills (3)  a, b, c\n'), /Always-on/);
});
