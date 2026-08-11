import { definePlugin, scriptPermission } from '@agent-kit/api';

import { checkChromeAvailable } from './chrome-check.js';
import {
  checkDesignTokens,
  checkStaleTokenSeed,
  TOKENS_PATH,
} from './seed-check.js';
import { checkTailwindAvailable } from './tailwind-check.js';
import { renderTokenSeed } from './tokens-seed.js';

import type {
  Action,
  Answers,
  CheckResult,
  Ctx,
  ModuleDef,
  PluginApi,
} from '@agent-kit/api';

/**
 * The file types the design rule claims. Narrower than the accessibility rule's markup list on
 * purpose: this rule is about styling decisions, so it wants stylesheets and the component
 * files that carry class names, and it has nothing to say about a plain `.html` document with
 * no styling in it.
 */
const STYLED_GLOBS = [
  '**/*.css',
  '**/*.jsx',
  '**/*.tsx',
  '**/*.svelte',
  '**/*.vue',
  '**/*.astro',
] as const;

/**
 * What each opt-in game reference answers, keyed by its `design-game` option value.
 *
 * The authority on which guides exist. `GAME_GUIDES` derives its values from these keys, so a
 * new guide cannot be installed without also getting the routing line that makes it reachable,
 * which is the whole point of linking them conditionally.
 */
const GAME_GUIDE_QUESTIONS: Record<string, string> = {
  hud: 'Building a HUD with DOM elements over canvas',
  visual: 'Game visual hierarchy, color, and motion',
};

/**
 * The design rule's routing table can only link a reference file that this install actually
 * ships. `design-tailwind-theming.md` and the game guides are option-gated, so their links are
 * appended to the rule body from here instead of living in the payload file, where they would
 * dangle whenever the option was not chosen.
 */
function designRuleAppendBody(
  tailwindSelected: boolean,
  chosenGameGuides: string[],
): string | undefined {
  const links: Array<{ question: string; name: string }> = [];
  if (tailwindSelected) {
    links.push({
      question:
        'Extending Tailwind into a design system, or building a theme that switches at runtime',
      name: 'design-tailwind-theming',
    });
  }
  for (const guide of chosenGameGuides) {
    const question = GAME_GUIDE_QUESTIONS[guide];
    if (!question) continue;
    links.push({ question, name: `design-game-${guide}` });
  }
  if (links.length === 0) return undefined;
  const bullets = links
    .map((link) => `- **${link.question}:** \`../reference/${link.name}.md\`\n`)
    .join('');
  return `\n## Also installed in this repo\n\n${bullets}`;
}

/**
 * The design system, and the guidance for an agent editing UI code.
 *
 * The token set is a SEED, never a copy. The values belong to the repo, so `update` must not
 * refresh them. The rule holds only the non-negotiables and a routing table, and the token set
 * itself stays out of context until `design.mjs` is asked for a specific token. A design system
 * inlined into a path-scoped rule is paid on every UI turn for values relevant on almost none
 * of them.
 */
function designModule(api: PluginApi): ModuleDef {
  const id = 'design';
  return {
    id,
    title: 'Design system (.claude/design/tokens.json + design rule)',
    group: 'optional',
    hint(): string {
      return 'a DTCG token set an agent queries by name, plus a path-scoped rule covering contrast, hit targets, type scale, and spacing rhythm';
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(_ctx: Ctx, answers: Answers): Action[] {
      const tailwindSelected = answers.moduleIds.includes(
        `${api.alias}/design-tailwind`,
      );
      const chosenGuides =
        answers.moduleOptions[`${api.alias}/design-game`] ?? [];
      const ruleAppendBody = designRuleAppendBody(
        tailwindSelected,
        chosenGuides,
      );
      const seedAction: Action[] = tailwindSelected
        ? []
        : [
            {
              kind: 'seed',
              dest: TOKENS_PATH,
              content: renderTokenSeed(),
              module: id,
              reason: 'DTCG design system, yours to replace',
            },
          ];
      const adviseText = tailwindSelected
        ? `Design system driven by the Tailwind theme, so no ${TOKENS_PATH} was seeded. Queries answer from this repo's own \`@theme\` block merged with Tailwind's defaults. Query it with \`node .claude/scripts/design.mjs token <name>\`, list names with \`list\`, and print the spacing, type, and radius scales with \`scales\`. See the design-tailwind advisory for the full Tailwind flow. The rule installs at .claude/rules/design.md, path-scoped via its \`paths:\` frontmatter so Claude Code loads it only when UI code is in the working set. Trim \`paths:\` to what this repo has, and keep the frontmatter, since a rule WITHOUT \`paths:\` is loaded on every turn. The rule covers ${STYLED_GLOBS.length} extensions by default: ${STYLED_GLOBS.join(', ')}.`
        : `Design system seeded at ${TOKENS_PATH} in W3C DTCG format (Design Tokens Format Module 2025.10). It is YOURS: the kit writes it once and never refreshes it, and the values it ships are brand-neutral placeholders. Replace them before trusting any design check, because a check against placeholders returns confident nonsense. Query it with \`node .claude/scripts/design.mjs token <name>\`, list names with \`list\`, and print the spacing, type, and radius scales with \`scales\`. The rule installs at .claude/rules/design.md, path-scoped via its \`paths:\` frontmatter so Claude Code loads it only when UI code is in the working set. Trim \`paths:\` to what this repo has, and keep the frontmatter, since a rule WITHOUT \`paths:\` is loaded on every turn. The rule covers ${STYLED_GLOBS.length} extensions by default: ${STYLED_GLOBS.join(', ')}.`;
      return [
        api.payload.rule(
          id,
          'design',
          'path-scoped design rule, loaded only when UI code is in the working set',
          ruleAppendBody,
        ),
        // Not `design-principles`: the CLI's code-cleanliness module already owns that
        // filename for a document about software structure, and the two would silently
        // overwrite each other in any repo running both.
        api.payload.reference(
          id,
          'design-visual-principles',
          'pull-only design principles, the layer that holds across design systems',
        ),
        api.payload.reference(
          id,
          'design-layout',
          'pull-only layout guide: fluid grids, container queries, grouping, target sizing',
        ),
        api.payload.reference(
          id,
          'design-performance',
          'pull-only guide to the design decisions that cost rendering performance',
        ),
        api.payload.script(
          id,
          'design.mjs',
          'token lookup, scale listing, and extraction over the design system',
        ),
        // Every lib design.mjs imports has to be listed here. One left out installs a script
        // that fails with ERR_MODULE_NOT_FOUND in the user's repo, which no unit test catches.
        api.payload.lib(id, 'dtcg-normalize.mjs'),
        api.payload.lib(id, 'tailwind-theme.mjs'),
        api.payload.lib(id, 'css-custom-properties.mjs'),
        api.payload.lib(id, 'style-literals.mjs'),
        api.payload.lib(id, 'design-checks.mjs'),
        api.payload.lib(id, 'cdp-session.mjs'),
        api.payload.lib(id, 'rendered-checks.mjs'),
        ...seedAction,
        {
          kind: 'merge-settings',
          module: id,
          fragment: {
            permissions: { allow: [scriptPermission('design.mjs')] },
          },
        },
        {
          kind: 'advise',
          text: adviseText,
          module: id,
        },
      ];
    },
    check(ctx: Ctx): CheckResult {
      // Which question to ask depends on where tokens come from. With design-tailwind
      // installed there is deliberately no token file, so checkDesignTokens would warn about
      // the correct state on every run, and a check that cries wolf is a check people stop
      // reading.
      const tokens = ctx.claude.manifest?.modules?.includes(
        `${api.alias}/design-tailwind`,
      )
        ? checkStaleTokenSeed(ctx)
        : checkDesignTokens(ctx);
      const chrome = checkChromeAvailable();
      return {
        findings: [...tokens.findings, ...chrome.findings],
        readouts: [...tokens.readouts, ...chrome.readouts],
      };
    },
  };
}

/**
 * The review half: an agent that audits a UI diff against the design system, and the skill that
 * drives the loop. Separate from the base module because a repo can want the token set and the
 * rule without installing a reviewer and a skill.
 *
 * The split of labor is settled by measurement, not taste. A no-plugin baseline over three
 * fixtures already found both contrast failures and the undersized hit target on its own, but
 * could not name which token a hardcoded literal should be, and it reported findings on a file
 * that was already correct. So the script owns precision and the agent owns restraint.
 */
function designReviewModule(api: PluginApi): ModuleDef {
  const id = 'design-review';
  return {
    id,
    title: 'Design review (/design-review + design-reviewer agent)',
    group: 'optional',
    hint(): string {
      return 'check a UI diff against the design system: exact contrast ratios, nearest scale values, and the token a literal should have been';
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(): Action[] {
      return [
        api.payload.skill(
          id,
          'design-review',
          'run the deterministic checks, then layer judgment on what they cannot compute',
        ),
        api.payload.agent(
          id,
          'design-reviewer',
          'read-only design-system auditor',
        ),
        {
          kind: 'advise',
          text: 'Design review installed. Run /design-review after changing UI code. It runs `node .claude/scripts/design.mjs check` over the changed files, which computes exact contrast ratios, the nearest value on each scale, and which token a hardcoded literal should have been. The design-reviewer agent then covers only what the script cannot compute. It needs the design module for the script and the token set. Accessibility stays with the accessibility plugin, and this review defers to it rather than duplicating WCAG coverage.',
          module: id,
        },
      ];
    },
  };
}

/**
 * Makes the repo's own Tailwind v4 theme the design system `design.mjs` queries and audits,
 * in place of the DTCG token seed. Depends on nothing from the `design` module: a repo can
 * install this alone and still get the doctor check and the payload libs, though the query
 * commands stay inert without `design` installed for the script itself.
 */
function designTailwindModule(api: PluginApi): ModuleDef {
  const id = 'design-tailwind';
  return {
    id,
    title:
      'Tailwind design system (query the repo theme instead of a token file)',
    group: 'optional',
    hint(): string {
      return "the repo's own Tailwind v4 theme becomes the design system the plugin queries and audits";
    },
    // Detectable from `ctx.rootPkg`, unlike `design-game`, but `defaultEnabled(ctx)` cannot
    // see `answers.moduleIds` and this module's whole value depends on `design` also being
    // selected. Auto-enabling here would install libs for a script that may not be installed.
    defaultEnabled(): boolean {
      return false;
    },
    plan(_ctx: Ctx, answers: Answers): Action[] {
      // The theming reference is linked only from the design rule's `appendBody`, which the
      // `design` module owns. Installing it without `design` selected would leave it an
      // orphan no rule, skill, or agent ever routes a reader to.
      const designSelected = answers.moduleIds.includes(`${api.alias}/design`);
      const referenceLine = designSelected
        ? 'See .claude/reference/design-tailwind-theming.md for how to extend it and build a runtime theme, linked from the design rule.'
        : "The theming reference guide was NOT installed, because only the design module's rule can link it into an agent's working context. Install design/design alongside this module to get .claude/reference/design-tailwind-theming.md.";
      return [
        // Every lib these scripts import has to be listed here. One left out installs a
        // script that fails with ERR_MODULE_NOT_FOUND in the user's repo, which no unit
        // test catches.
        api.payload.lib(id, 'tailwind-host-packages.mjs'),
        api.payload.lib(id, 'tailwind-design-system.mjs'),
        api.payload.lib(id, 'tailwind-theme-to-dtcg.mjs'),
        api.payload.lib(id, 'tailwind-candidates.mjs'),
        api.payload.lib(id, 'tailwind-checks.mjs'),
        api.payload.lib(id, 'is-record.mjs'),
        api.payload.template(
          id,
          'tailwind-theme.css.template',
          'starter @theme to copy into your own entry stylesheet',
        ),
        ...(designSelected
          ? [
              api.payload.reference(
                id,
                'design-tailwind-theming',
                'pull-only guide to extending Tailwind into a design system and building a runtime theme',
              ),
            ]
          : []),
        {
          kind: 'advise',
          text: `Tailwind theme wired as the design system. No ${TOKENS_PATH} is seeded, and design.mjs answers token, list, and scales queries from this repo's own @theme block merged with Tailwind's defaults. It reads whichever stylesheet imports Tailwind, or the one you name with --theme <path>. \`check\` also scans each file's class names with \`@tailwindcss/oxide\` and judges them against the same theme, alongside any \`<style>\` block declarations, naming an arbitrary value's nearest theme step and reporting a contrast finding for a \`bg-*\`/\`text-*\` pairing on one element. That half needs \`@tailwindcss/oxide\` installed separately from \`tailwindcss\`, and \`check\` says so rather than reporting a clean file when it is missing. The kit never writes into the Tailwind compile path, so your entry stylesheet and build config are untouched. A starter \`@theme\` installs at .claude/kit-templates/tailwind-theme.css.template, a reference to copy from, not a file the kit ever writes into your CSS. ${referenceLine} It needs the design module for the script itself. If this repo already had ${TOKENS_PATH} from an earlier install, nothing reads it now and the kit will not delete it, since a seed is yours. Remove it yourself, and \`agent-kit doctor\` will remind you while it is still there.`,
          module: id,
        },
      ];
    },
    check(ctx: Ctx): CheckResult {
      return checkTailwindAvailable(ctx);
    },
  };
}

/** The game reference documents, each an option value rather than a module of its own. */
const GAME_GUIDES = Object.keys(GAME_GUIDE_QUESTIONS);

/**
 * Game UI reference material, all pull-only and all off by default.
 *
 * One module with options rather than one module per document, because module ids are permanent
 * once shipped (see `src/retired-modules.ts`) and this is one theme with facets.
 *
 * Deliberately no rule. "This repo is a game" is not detectable from a file extension, so a
 * path-scoped game rule would load on every React or Svelte turn in every non-game repo. The
 * design module's rule links whichever guide this module installs instead, via the `design`
 * module's `appendBody`.
 */
function designGameModule(api: PluginApi): ModuleDef {
  const id = 'design-game';
  return {
    id,
    title: 'Game UI references (.claude/reference/design-game-*.md)',
    group: 'optional',
    hint(): string {
      return 'pull-only references for game interfaces: DOM-over-canvas HUD layering, and game visual hierarchy, color, and motion';
    },
    defaultEnabled(): boolean {
      return false;
    },
    options: {
      prompt: 'Which game UI references should install?',
      choices: [
        { value: 'hud', label: 'HUD and canvas layering' },
        { value: 'visual', label: 'Game visual hierarchy, color, and motion' },
      ],
      // Neither is true of a repo the installer knows nothing about, and `defaults` is what
      // every `--yes` run gets. A game reference is an explicit choice.
      defaults: [],
    },
    plan(_ctx, answers): Action[] {
      const chosen = answers.moduleOptions[`${api.alias}/${id}`] ?? [];
      if (chosen.length === 0) return [];
      // A game guide is linked only from the design rule's `appendBody`, which the `design`
      // module owns. Installing it without `design` selected would leave it an orphan no
      // rule, skill, or agent ever routes a reader to, so the guides stay uninstalled until
      // both are selected.
      const designSelected = answers.moduleIds.includes(`${api.alias}/design`);
      if (!designSelected) {
        return [
          {
            kind: 'advise',
            text: "Game UI references were NOT installed, because only the design module's rule can link a guide into an agent's working context. Install design/design alongside design-game to get the guides you chose under .claude/reference/.",
            module: id,
          },
        ];
      }
      const guideActions = chosen.flatMap((guide): Action[] => {
        if (!GAME_GUIDES.includes(guide)) return [];
        return [
          api.payload.reference(
            id,
            `design-game-${guide}`,
            `pull-only game ${guide} reference, opt-in via design-game options`,
          ),
        ];
      });
      if (guideActions.length === 0) return [];
      return [
        ...guideActions,
        {
          kind: 'advise',
          text: 'Game UI references installed under .claude/reference/. They are PULL-ONLY, so they cost nothing until something reads them. There is deliberately no game rule: whether a repo is a game cannot be detected from a file extension, so a path-scoped rule would load on every component turn in a repo that is not one. The design module is installed alongside this one, so its rule links each guide you chose here under "Also installed in this repo".',
          module: id,
        },
      ];
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  designModule(api),
  designReviewModule(api),
  designTailwindModule(api),
  designGameModule(api),
]);
