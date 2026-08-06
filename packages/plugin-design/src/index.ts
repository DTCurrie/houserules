import { definePlugin, scriptPermission } from '@agent-kit/cli/plugin';

import { checkChromeAvailable } from './chrome-check.js';
import { checkDesignTokens, TOKENS_PATH } from './seed-check.js';
import { renderTokenSeed } from './tokens-seed.js';

import type {
  Action,
  CheckResult,
  Ctx,
  ModuleDef,
  PluginApi,
} from '@agent-kit/cli/plugin';

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
    plan(): Action[] {
      return [
        api.payload.rule(
          id,
          'design',
          'path-scoped design rule, loaded only when UI code is in the working set',
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
        {
          kind: 'seed',
          dest: TOKENS_PATH,
          content: renderTokenSeed(),
          module: id,
          reason: 'DTCG design system, yours to replace',
        },
        {
          kind: 'merge-settings',
          module: id,
          fragment: {
            permissions: { allow: [scriptPermission('design.mjs')] },
          },
        },
        {
          kind: 'advise',
          text: `Design system seeded at ${TOKENS_PATH} in W3C DTCG format (Design Tokens Format Module 2025.10). It is YOURS: the kit writes it once and never refreshes it, and the values it ships are brand-neutral placeholders. Replace them before trusting any design check, because a check against placeholders returns confident nonsense. Query it with \`node .claude/scripts/design.mjs token <name>\`, list names with \`list\`, and print the spacing, type, and radius scales with \`scales\`. The rule installs at .claude/rules/design.md, path-scoped via its \`paths:\` frontmatter so Claude Code loads it only when UI code is in the working set. Trim \`paths:\` to what this repo actually has, and keep the frontmatter, since a rule WITHOUT \`paths:\` is loaded on every turn. The rule covers ${STYLED_GLOBS.length} extensions by default: ${STYLED_GLOBS.join(', ')}.`,
          module: id,
        },
      ];
    },
    check(ctx: Ctx): CheckResult {
      const tokens = checkDesignTokens(ctx);
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
    title: 'Design review (/design-review + art-director agent)',
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
          'art-director',
          'read-only design-system auditor',
        ),
        {
          kind: 'advise',
          text: 'Design review installed. Run /design-review after changing UI code. It runs `node .claude/scripts/design.mjs check` over the changed files, which computes exact contrast ratios, the nearest value on each scale, and which token a hardcoded literal should have been. The art-director agent then covers only what the script cannot compute. It needs the design module for the script and the token set. Accessibility stays with the accessibility plugin, and this review defers to it rather than duplicating WCAG coverage.',
          module: id,
        },
      ];
    },
  };
}

/** The game reference documents, each an option value rather than a module of its own. */
const GAME_GUIDES = ['hud', 'visual'];

/**
 * Game UI reference material, all pull-only and all off by default.
 *
 * One module with options rather than one module per document, because module ids are permanent
 * once shipped (see `src/retired-modules.ts`) and this is one theme with facets.
 *
 * Deliberately no rule. "This repo is a game" is not detectable from a file extension, so a
 * path-scoped game rule would load on every React or Svelte turn in every non-game repo. The
 * design rule's routing table is how a reader finds these instead.
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
          text: 'Game UI references installed under .claude/reference/. They are PULL-ONLY, so they cost nothing until something reads them. There is deliberately no game rule: whether a repo is a game cannot be detected from a file extension, so a path-scoped rule would load on every component turn in a repo that is not one. The design rule does NOT link them either, because a rule pointing at an optional file dangles wherever that option was not chosen. Read them directly when you are building a HUD, or add your own pointer to the frontmatter-owned half of a rule if this repo is a game.',
          module: id,
        },
      ];
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  designModule(api),
  designReviewModule(api),
  designGameModule(api),
]);
