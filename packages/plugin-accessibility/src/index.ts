import { definePlugin, scriptPermission } from '@houserules/api';
import type {
  Action,
  CheckResult,
  Ctx,
  ModuleDef,
  PluginApi,
} from '@houserules/api';

import { checkAccessibilityLinter } from './linter-check.js';

/**
 * The markup extensions the base rule claims. Every framework guide added later must draw its
 * own `paths:` from this list, never widen past it: a guide loaded on a file where the base
 * rule is absent defers to a rule that is not in context. See CONVENTIONS §6.
 */
const MARKUP_GLOBS = [
  '**/*.html',
  '**/*.jsx',
  '**/*.tsx',
  '**/*.svelte',
  '**/*.vue',
  '**/*.astro',
] as const;

/**
 * The per-framework guides, each shipping only the residue that differs for that framework. They
 * are option values of the base module rather than modules of their own, because a guide defers
 * to the base rule and one installed without it is a dangling pointer.
 */
const FRAMEWORK_GUIDES = ['html', 'react', 'svelte', 'vue'];

/**
 * WCAG guidance for agents editing markup. The rule holds the non-negotiables and the routing
 * table. The success criteria themselves ship separately as a pull-only reference, because 87
 * criteria inlined into a `paths:`-scoped rule would be paid on every markup turn for text
 * relevant on almost none of them.
 */
function accessibilityModule(api: PluginApi): ModuleDef {
  const id = 'accessibility';
  return {
    id,
    title: 'Accessibility rule (.claude/rules/accessibility.md)',
    group: 'optional',
    hint(): string {
      return 'path-scoped rule for HTML and HTML-like markup: semantic elements, accessible names, keyboard reachability, WCAG routing';
    },
    defaultEnabled(): boolean {
      return false;
    },
    options: {
      prompt: 'Which framework guides should install alongside the base rule?',
      choices: [
        { value: 'html', label: 'Plain HTML and Astro' },
        { value: 'react', label: 'React and JSX' },
        { value: 'svelte', label: 'Svelte' },
        { value: 'vue', label: 'Vue' },
      ],
      // `html` alone, because it is the only guide true of a repo we know nothing about, and
      // `defaults` is what every `--yes` run gets. A framework guide is an explicit choice.
      defaults: ['html'],
    },
    plan(_ctx, answers): Action[] {
      const chosen = answers.moduleOptions[`${api.alias}/${id}`] ?? [];
      const guideActions = chosen.flatMap((framework): Action[] => {
        if (!FRAMEWORK_GUIDES.includes(framework)) return [];
        return [
          api.payload.rule(
            id,
            `accessibility-${framework}`,
            `${framework} accessibility guide, opt-in via accessibility options`,
          ),
        ];
      });
      return [
        ...guideActions,
        api.payload.rule(
          id,
          'accessibility',
          'path-scoped accessibility rule, loaded only when markup is in the working set',
        ),
        api.payload.reference(
          id,
          'wcag22',
          'pull-only WCAG 2.2 success criteria, generated from the W3C source',
        ),
        api.payload.script(
          id,
          'wcag.mjs',
          'criterion lookup and the routing table over changed markup',
        ),
        api.payload.lib(id, 'wcag-patterns.mjs'),
        {
          kind: 'merge-settings',
          module: id,
          fragment: {
            permissions: { allow: [scriptPermission('wcag.mjs')] },
          },
        },
        {
          kind: 'advise',
          text: `Accessibility rule installed at .claude/rules/accessibility.md, path-scoped via its \`paths:\` frontmatter so Claude Code loads it only when markup is in the working set. Trim \`paths:\` to the markup this repo actually has, and keep the frontmatter — a rule file WITHOUT \`paths:\` is loaded on every turn. The rule covers ${MARKUP_GLOBS.length} extensions by default: ${MARKUP_GLOBS.join(', ')}. This rule is guidance, not a linter. Install your framework's accessibility linter alongside it, such as eslint-plugin-jsx-a11y for JSX. The 87 WCAG 2.2 success criteria install at .claude/reference/wcag22.md, which is PULL-ONLY at roughly 48KB. Grep it for a criterion number or keyword and read that window. Enabling the read-guard module makes that access rule mechanical instead of advisory.`,
          module: id,
        },
      ];
    },
    check(ctx: Ctx): CheckResult {
      return checkAccessibilityLinter(ctx);
    },
  };
}

/**
 * The review half: an agent that audits a markup diff against the corpus, and the skill that
 * drives the loop. Separate from the base module because a repo can want the path-scoped
 * guidance and the lookup script without installing a reviewer and a skill.
 */
function accessibilityReviewModule(api: PluginApi): ModuleDef {
  const id = 'accessibility-review';
  return {
    id,
    title: 'Accessibility review (/accessibility-review + reviewer agent)',
    group: 'optional',
    hint(): string {
      return 'audit a markup diff against the criteria the router names, not against the whole corpus';
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(): Action[] {
      return [
        api.payload.skill(
          id,
          'accessibility-review',
          'route changed markup to its criteria, then check each one',
        ),
        api.payload.agent(
          id,
          'accessibility-reviewer',
          'read-only markup accessibility auditor',
        ),
        {
          kind: 'advise',
          text: 'Accessibility review installed. Run /accessibility-review after changing markup. It routes your changed files through .claude/scripts/wcag.mjs, reads only the criteria that came back, and reconciles those against your own accessibility linter. It needs the a11y accessibility module for the script and the corpus.',
          module: id,
        },
      ];
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  accessibilityModule(api),
  accessibilityReviewModule(api),
]);
