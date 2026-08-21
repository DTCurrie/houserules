import { definePlugin } from '@houserules/api';
import type { Action, ModuleDef, PluginApi } from '@houserules/api';

const FRAMEWORK_GUIDES = ['threlte', 'r3f'];

const FRAMEWORK_TITLES: Record<string, string> = {
  threlte: 'Threlte',
  r3f: 'React Three Fiber',
};

/**
 * The section appended below `three-upstream-docs.md` linking each chosen framework's own
 * upstream-docs file, or undefined when no framework guide was chosen so the base file
 * carries no bindings section at all.
 */
function upstreamDocsLinks(chosenFrameworks: string[]): string | undefined {
  if (chosenFrameworks.length === 0) return undefined;
  const lines = chosenFrameworks.map(
    (guide) =>
      `- ${FRAMEWORK_TITLES[guide]}: \`three-upstream-docs-${guide}.md\` beside this file.\n`,
  );
  return `\n## Framework bindings installed in this repo\n\n${lines.join('')}`;
}

/**
 * Option values that install a pull-only reference rather than a path-scoped rule. Renderer
 * performance is reference material because it is read when a frame budget is the problem, not
 * on every turn that touches the Three.js layer.
 */
const REFERENCE_GUIDES = ['performance'];

/**
 * Ships the path-scoped Three.js rule, plus opt-in Threlte and React Three Fiber guides. The
 * guides are option values of the base module rather than modules of their own, because each
 * one is a dangling pointer without the base rule installed alongside it.
 *
 * `defaults: []`: neither binding is true of a repo the installer knows nothing about, so
 * neither is a safe default. A guide is an explicit choice, made once the caller knows which
 * framework the repo actually uses.
 */
function threeModule(api: PluginApi): ModuleDef {
  const id = 'three';
  return {
    id,
    title: 'Three.js rule (.claude/rules/three.md)',
    group: 'optional',
    hint(): string {
      return 'path-scoped rule for Three.js extension patterns, with opt-in Threlte and R3F guides';
    },
    defaultEnabled(): boolean {
      return false;
    },
    options: {
      prompt: 'Which framework guides should install alongside the base rule?',
      choices: [
        { value: 'threlte', label: 'Threlte (Svelte)' },
        { value: 'r3f', label: 'React Three Fiber' },
        {
          value: 'performance',
          label: 'Renderer performance reference (pull-only)',
        },
      ],
      defaults: [],
    },
    plan(_ctx, answers): Action[] {
      const chosen = answers.moduleOptions[`${api.alias}/${id}`] ?? [];
      // Filtered from FRAMEWORK_GUIDES rather than from `chosen`, so the emitted actions
      // and the appendBody below keep one deterministic order however the selection was
      // recorded.
      const chosenFrameworks = FRAMEWORK_GUIDES.filter((guide) =>
        chosen.includes(guide),
      );
      const guideActions = chosenFrameworks.flatMap((guide): Action[] => [
        api.payload.rule(
          id,
          `three-${guide}`,
          `${guide} binding guide for the Three.js rule, opt-in via three options`,
        ),
        api.payload.reference(
          id,
          `three-upstream-docs-${guide}`,
          `${guide} upstream docs for the Three.js rule, opt-in via three options`,
        ),
      ]);
      const referenceActions = chosen.flatMap((guide): Action[] => {
        if (!REFERENCE_GUIDES.includes(guide)) return [];
        return [
          api.payload.reference(
            id,
            'three-performance',
            'pull-only renderer performance reference, opt-in via three options',
          ),
        ];
      });
      // Only the bullet. The base rule's own payload body already carries the
      // "Also installed in this repo" heading for the unconditional debugging reference, so
      // repeating it here renders the heading twice whenever this option is chosen.
      const performanceLink = chosen.includes('performance')
        ? '- **Renderer performance is a problem:** `../reference/three-performance.md`\n'
        : undefined;
      return [
        ...guideActions,
        ...referenceActions,
        api.payload.rule(
          id,
          'three',
          'path-scoped Three.js extension-pattern rule, loaded only when the Three.js layer is in the working set',
          performanceLink,
        ),
        // Unconditional, unlike the performance reference, because the base rule links it from
        // its own payload body rather than from `appendBody`. An option value would leave that
        // link dangling in every install that skipped the option. The framework halves are
        // conditional siblings, linked from here only when their guide was chosen.
        api.payload.reference(
          id,
          'three-upstream-docs',
          'pull-only pointer to the upstream llms.txt docs for Three.js and the chosen bindings',
          upstreamDocsLinks(chosenFrameworks),
        ),
        // Unconditional for the same reason as three-upstream-docs: the base rule links it
        // from its own payload body, so it must always be present.
        api.payload.reference(
          id,
          'three-debugging',
          'pull-only diagnostic reference for a broken or slow Three.js render',
        ),
        {
          kind: 'advise',
          text: "Three.js rule installed at .claude/rules/three.md, path-scoped via its `paths:` frontmatter (**/three/**, **/*.three.ts, **/*.glsl, **/*.wgsl) so Claude Code loads it only when Three.js code is in the working set. Trim `paths:` to where this repo's Three.js layer actually lives, or widen it if that layer is not under a three/ directory. If you widen the base rule's paths, widen each installed guide's paths the same way, since every guide glob is a strict subset of the base rule's so a guide never loads without it. Keep the frontmatter — a rule file WITHOUT `paths:` is loaded on every turn.",
          module: id,
        },
      ];
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  threeModule(api),
]);
