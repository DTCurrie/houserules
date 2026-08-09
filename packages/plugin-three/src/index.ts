import { definePlugin } from '@agent-kit/cli/plugin';
import type { Action, ModuleDef, PluginApi } from '@agent-kit/cli/plugin';

const FRAMEWORK_GUIDES = ['threlte', 'r3f'];

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
      const guideActions = chosen.flatMap((guide): Action[] => {
        if (!FRAMEWORK_GUIDES.includes(guide)) return [];
        return [
          api.payload.rule(
            id,
            `three-${guide}`,
            `${guide} binding guide for the Three.js rule, opt-in via three options`,
          ),
        ];
      });
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
      const performanceLink = chosen.includes('performance')
        ? '\n## Also installed in this repo\n\n- **Renderer performance is a problem:** `../reference/three-performance.md`\n'
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
        // link dangling in every install that skipped the option.
        api.payload.reference(
          id,
          'three-upstream-docs',
          'pull-only pointer to the upstream llms.txt docs for Three.js, Threlte, and R3F',
        ),
        {
          kind: 'advise',
          text: "Three.js rule installed at .claude/rules/three.md, path-scoped via its `paths:` frontmatter (**/three/**, **/*.three.ts, **/*.glsl) so Claude Code loads it only when Three.js code is in the working set. Trim `paths:` to where this repo's Three.js layer actually lives, or widen it if that layer is not under a three/ directory. If you widen the base rule's paths, widen each installed guide's paths the same way, since every guide glob is a strict subset of the base rule's so a guide never loads without it. Keep the frontmatter — a rule file WITHOUT `paths:` is loaded on every turn.",
          module: id,
        },
      ];
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  threeModule(api),
]);
