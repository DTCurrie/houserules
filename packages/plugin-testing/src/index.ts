import { definePlugin } from '@agent-kit/cli/plugin';
import type {
  Action,
  Answers,
  Ctx,
  ModuleDef,
  PluginApi,
} from '@agent-kit/cli/plugin';

/**
 * The base rule holds everything that applies to any test runner with a `describe`/`it`
 * shape: whether a test is worth writing, placement, what to test, structure, naming, and
 * the Never list. The language
 * guides are the residue that differs per language: the concrete suffix list, the Vitest
 * and TypeScript examples, and the build-exclusion advice. They ship as option values of
 * this one module rather than as separate `ModuleDef`s, since a language guide is
 * meaningless installed without the base it assumes.
 */
function testingModule(api: PluginApi): ModuleDef {
  const id = 'testing';
  const languageRules: Record<string, string> = {
    typescript: 'testing-typescript',
    javascript: 'testing-javascript',
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
      prompt:
        'Which language guides should install alongside the base testing rule?',
      choices: [
        { value: 'typescript', label: 'TypeScript' },
        { value: 'javascript', label: 'JavaScript' },
      ],
      defaults: ['typescript'],
    },
    plan(_ctx: Ctx, answers: Answers): Action[] {
      const chosen = answers.moduleOptions[`${api.alias}/${id}`] ?? [];
      const languageActions = chosen.flatMap((language): Action[] => {
        const name = languageRules[language];
        if (!name) return [];
        return [
          api.payload.rule(
            id,
            name,
            `${language} testing rule, opt-in via testing options`,
          ),
        ];
      });
      return [
        api.payload.rule(
          id,
          'testing',
          'path-scoped testing rule, loaded only when a test file is in play',
        ),
        ...languageActions,
        {
          kind: 'advise',
          text: 'Testing rule installed at .claude/rules/testing.md, path-scoped via its `paths:` frontmatter so Claude Code loads it only when a test file is in the working set. Trim `paths:` to the suffixes this repo actually uses, and keep the frontmatter — a rule file WITHOUT `paths:` is loaded on every turn. Two decisions from the language guides need confirming: pick ONE test suffix (.test.ts or .spec.ts) if the repo currently mixes them, and confirm tests are excluded from your build config. A test under a compiled source root is emitted into the published output and imports the test runner, which is a dev dependency.',
          module: id,
        },
      ];
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  testingModule(api),
]);
