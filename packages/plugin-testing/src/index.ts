import { definePlugin, scriptPermission } from '@houserules/api';
import type {
  Action,
  Answers,
  Ctx,
  ModuleDef,
  PluginApi,
} from '@houserules/api';

import { playwrightMcpModule } from './playwright-mcp.js';

/**
 * The base rule holds everything that applies to any test runner with a `describe`/`it`
 * shape: whether a test is worth writing, placement, what to test, structure, naming, and
 * the Never list. The guides are the residue that does NOT generalize: a language's suffix
 * list and build-exclusion advice, a framework's runner setup, a domain's assertion
 * targets. They ship as option values of this one module rather than as separate
 * `ModuleDef`s, since a guide is meaningless installed without the base it assumes.
 *
 * Guides are no longer language-only. `svelte` and `3d` select on framework and on domain,
 * so the map is keyed by guide rather than by language, and a new guide is one entry here
 * plus one rule file.
 */
function testingModule(api: PluginApi): ModuleDef {
  const id = 'testing';
  const guideRules: Record<string, string> = {
    typescript: 'testing-typescript',
    javascript: 'testing-javascript',
    svelte: 'testing-svelte',
    '3d': 'testing-3d',
  };
  return {
    id,
    title: 'Testing discipline rule (.claude/rules/testing.md)',
    group: 'optional',
    hint(): string {
      return 'path-scoped rule: a test must fail when the behavior breaks, no coverage-chasing, colocate unit tests in `__test__`, prefer units over end-to-end, behavioral test names, no comments explaining assertions';
    },
    defaultEnabled(): boolean {
      return false;
    },
    options: {
      prompt: 'Which guides should install alongside the base testing rule?',
      choices: [
        { value: 'typescript', label: 'TypeScript' },
        { value: 'javascript', label: 'JavaScript' },
        { value: 'svelte', label: 'Svelte' },
        { value: '3d', label: '3D and WebGL' },
      ],
      defaults: ['typescript'],
    },
    plan(_ctx: Ctx, answers: Answers): Action[] {
      const chosen = answers.moduleOptions[`${api.alias}/${id}`] ?? [];
      const guideActions = chosen.flatMap((guide): Action[] => {
        const name = guideRules[guide];
        if (!name) return [];
        return [
          api.payload.rule(
            id,
            name,
            `${guide} testing rule, opt-in via testing options`,
          ),
        ];
      });
      return [
        api.payload.rule(
          id,
          'testing',
          'path-scoped testing rule, loaded only when a test file is in play',
        ),
        ...guideActions,
        api.payload.script(
          id,
          'test-layout.mjs',
          'checks structural placement clauses of testing.md and testing-typescript/javascript.md: colocation in __test__, __test__ directory contents, one suffix convention, no .e2e.test tier, no test leaking into build output',
        ),
        api.payload.script(
          id,
          'test-config.mjs',
          'checks vitest config clauses: expect.requireAssertions enabled, typecheck enabled for a type test, Svelte config split into client/ssr/server projects',
        ),
        {
          kind: 'merge-settings',
          module: id,
          fragment: {
            permissions: {
              allow: [
                scriptPermission('test-layout.mjs'),
                scriptPermission('test-config.mjs'),
              ],
            },
          },
        },
        {
          kind: 'advise',
          text: 'Testing rule installed at .claude/rules/testing.md, path-scoped via its `paths:` frontmatter so Claude Code loads it only when a test file is in the working set. Trim `paths:` to the suffixes this repo actually uses, and keep the frontmatter — a rule file WITHOUT `paths:` is loaded on every turn. Two decisions from the language guides need confirming: pick ONE test suffix (.test.ts or .spec.ts) if the repo currently mixes them, and confirm tests are excluded from your build config. A test under a compiled source root is emitted into the published output and imports the test runner, which is a dev dependency. Two checkers back the mechanical clauses each rule now points at: `node .claude/scripts/test-layout.mjs <file...> <build-output-dir>` checks colocation in __test__, the __test__ directory contents, one suffix convention, no .e2e.test tier, and a test leaked into the build output; `node .claude/scripts/test-config.mjs <vitest.config.ts> [setup-file...]` checks expect.requireAssertions, typecheck for a type test, and (with the Svelte guide) the client/ssr/server project split. Both print "No findings." plus a "Not checked by this checker" list, and exit 1 only on a real finding. Wire either into a check gate once the repo has enough test files to be worth it.',
          module: id,
        },
      ];
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  testingModule(api),
  playwrightMcpModule(api),
]);
