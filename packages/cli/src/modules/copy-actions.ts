import { join } from 'node:path';

import type { BodyAction, CopyAction } from '../actions.js';
import { payloadPath } from '../paths.js';

/**
 * The action builders bound to one payload root. The kit binds them to its own payload, and
 * a plugin gets them bound to the payload inside its own package, so the same seven builders
 * serve both without either knowing where the other's files live.
 */
export interface PayloadBuilders {
  script(module: string, name: string, reason: string): CopyAction;
  lib(module: string, name: string): CopyAction;
  skill(module: string, name: string, reason: string): CopyAction;
  agent(module: string, name: string, reason: string): CopyAction;
  rule(module: string, name: string, reason: string): BodyAction;
  reference(module: string, name: string, reason: string): CopyAction;
  template(module: string, rel: string, reason?: string): CopyAction;
  /**
   * Escape hatch for a destination the named builders do not cover, such as
   * `.claude/output-styles/`. `srcRel` resolves inside this payload root, so a plugin never
   * computes a path into its own package.
   */
  file(args: {
    module: string;
    srcRel: string;
    dest: string;
    reason: string;
    mode?: number;
  }): CopyAction;
}

/**
 * Binds the payload action builders to `payloadRoot`, an absolute path to a built payload
 * directory.
 *
 * A plugin never calls this itself. The kit resolves the plugin's package, builds the
 * instance, and hands it to the plugin factory. Path resolution stays in one place, and a
 * plugin cannot accidentally emit actions pointing at the kit's payload.
 */
export function createPayloadBuilders(payloadRoot: string): PayloadBuilders {
  const at = (...segments: string[]) => join(payloadRoot, ...segments);

  return {
    script(module, name, reason) {
      return {
        kind: 'copy',
        src: at('scripts', name),
        dest: `.claude/scripts/${name}`,
        mode: 0o755,
        module,
        reason,
      };
    },

    lib(module, name) {
      return {
        kind: 'copy',
        src: at('scripts', 'lib', name),
        dest: `.claude/scripts/lib/${name}`,
        module,
        reason: 'shared script library',
      };
    },

    skill(module, name, reason) {
      return {
        kind: 'copy',
        src: at('skills', name, 'SKILL.md'),
        dest: `.claude/skills/${name}/SKILL.md`,
        module,
        reason,
      };
    },

    agent(module, name, reason) {
      return {
        kind: 'copy',
        src: at('agents', `${name}.md`),
        dest: `.claude/agents/${name}.md`,
        module,
        reason,
      };
    },

    rule(module, name, reason) {
      return {
        kind: 'body',
        src: at('rules', `${name}.md`),
        dest: `.claude/rules/${name}.md`,
        module,
        reason,
      };
    },

    reference(module, name, reason) {
      return {
        kind: 'copy',
        src: at('reference', `${name}.md`),
        dest: `.claude/reference/${name}.md`,
        module,
        reason,
      };
    },

    template(module, rel, reason = 'reference template') {
      return {
        kind: 'copy',
        src: at('kit-templates', ...rel.split('/')),
        dest: `.claude/kit-templates/${rel}`,
        module,
        reason,
      };
    },

    file({ module, srcRel, dest, reason, mode }) {
      const action: CopyAction = {
        kind: 'copy',
        src: at(...srcRel.split('/')),
        dest,
        module,
        reason,
      };
      if (mode !== undefined) action.mode = mode;
      return action;
    },
  };
}

const kitBuilders = createPayloadBuilders(payloadPath());

export const script = kitBuilders.script;
export const lib = kitBuilders.lib;
export const skill = kitBuilders.skill;
export const agent = kitBuilders.agent;

/**
 * A Claude Code rule file. Claude Code loads `.claude/rules/` as memory, and a rule whose
 * frontmatter carries `paths:` globs loads only when a matching file is in the working set.
 * One without `paths:` is resident on every turn, so kit rules always ship with them.
 *
 * Split ownership, which is why this is a `body` action and not a `copy`. The `paths:` list
 * is yours, because only your repo knows which suffixes it uses, and the kit's own advise
 * text tells you to trim it. Everything below the closing `---` is the kit's, and stays
 * update-refreshable however far the frontmatter diverges. See {@link BodyAction}.
 */
export const rule = kitBuilders.rule;

/**
 * A pull-only doc. Unlike {@link rule}, `.claude/reference/` is not auto-loaded, so the doc
 * costs nothing until something reads it. That is why this is separate: prose too long to
 * keep resident lands here, and a path-scoped rule links to it, which keeps even the pointer
 * conditional.
 */
export const reference = kitBuilders.reference;

export const template = kitBuilders.template;
export const file = kitBuilders.file;
