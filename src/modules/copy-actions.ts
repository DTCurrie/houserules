import type { CopyAction } from '../actions.js';
import { payloadPath } from '../paths.js';

export function script(
  module: string,
  name: string,
  reason: string,
): CopyAction {
  return {
    kind: 'copy',
    src: payloadPath('scripts', name),
    dest: `.claude/scripts/${name}`,
    mode: 0o755,
    module,
    reason,
  };
}

export function lib(module: string, name: string): CopyAction {
  return {
    kind: 'copy',
    src: payloadPath('scripts', 'lib', name),
    dest: `.claude/scripts/lib/${name}`,
    module,
    reason: 'shared script library',
  };
}

export function skill(
  module: string,
  name: string,
  reason: string,
): CopyAction {
  return {
    kind: 'copy',
    src: payloadPath('skills', name, 'SKILL.md'),
    dest: `.claude/skills/${name}/SKILL.md`,
    module,
    reason,
  };
}

export function agent(
  module: string,
  name: string,
  reason: string,
): CopyAction {
  return {
    kind: 'copy',
    src: payloadPath('agents', `${name}.md`),
    dest: `.claude/agents/${name}.md`,
    module,
    reason,
  };
}

/**
 * A Claude Code rule file. Claude Code loads `.claude/rules/` as memory, and a rule whose
 * frontmatter carries `paths:` globs loads only when a matching file is in the working
 * set. One without `paths:` is resident on every turn, so kit rules always carry them.
 */
export function rule(module: string, name: string, reason: string): CopyAction {
  return {
    kind: 'copy',
    src: payloadPath('rules', `${name}.md`),
    dest: `.claude/rules/${name}.md`,
    module,
    reason,
  };
}

/**
 * A pull-only doc. Unlike {@link rule}, `.claude/reference/` is not auto-loaded, so the
 * doc costs nothing until something reads it. That is why this is separate: prose too
 * long to keep resident lands here, and a path-scoped rule links to it, which keeps even
 * the pointer conditional.
 */
export function reference(
  module: string,
  name: string,
  reason: string,
): CopyAction {
  return {
    kind: 'copy',
    src: payloadPath('reference', `${name}.md`),
    dest: `.claude/reference/${name}.md`,
    module,
    reason,
  };
}

/**
 * Stages a raw template for hand-instantiation.
 *
 * @param rel Forward-slash path relative to `payload/kit-templates`.
 */
export function template(
  module: string,
  rel: string,
  reason = 'reference template',
): CopyAction {
  return {
    kind: 'copy',
    src: payloadPath('kit-templates', ...rel.split('/')),
    dest: `.claude/kit-templates/${rel}`,
    module,
    reason,
  };
}
