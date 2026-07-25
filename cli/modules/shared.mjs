// Tiny action factories shared by the modules (claude-kit CLI).
import { payloadPath } from '../paths.mjs';

export function script(module, name, reason) {
  return {
    kind: 'copy',
    src: payloadPath('scripts', name),
    dest: `.claude/scripts/${name}`,
    mode: 0o755,
    module,
    reason,
  };
}

export function lib(module, name) {
  return {
    kind: 'copy',
    src: payloadPath('scripts', 'lib', name),
    dest: `.claude/scripts/lib/${name}`,
    module,
    reason: 'shared script library',
  };
}

export function skill(module, name, reason) {
  return {
    kind: 'copy',
    src: payloadPath('skills', name, 'SKILL.md'),
    dest: `.claude/skills/${name}/SKILL.md`,
    module,
    reason,
  };
}

export function agent(module, name, reason) {
  return {
    kind: 'copy',
    src: payloadPath('agents', `${name}.md`),
    dest: `.claude/agents/${name}.md`,
    module,
    reason,
  };
}

// A Claude Code rule file (.claude/rules/<name>.md). Claude Code loads this
// directory as memory: a rule whose frontmatter carries `paths:` globs loads only
// when a matching file is in the working set; one WITHOUT `paths:` is resident on
// every turn. Kit rules always carry `paths:`.
export function rule(module, name, reason) {
  return {
    kind: 'copy',
    src: payloadPath('rules', `${name}.md`),
    dest: `.claude/rules/${name}.md`,
    module,
    reason,
  };
}

// Stage a raw kit-templates/<rel> file for hand-instantiation. `rel` is a
// forward-slash path relative to payload/kit-templates (e.g. 'agents/foo.template').
export function template(module, rel, reason = 'reference template') {
  return {
    kind: 'copy',
    src: payloadPath('kit-templates', ...rel.split('/')),
    dest: `.claude/kit-templates/${rel}`,
    module,
    reason,
  };
}

export function hookCommand(scriptName) {
  return `node "$CLAUDE_PROJECT_DIR/.claude/scripts/${scriptName}"`;
}

// One settings fragment with a single hook entry.
export function hookFragment(event, matcher, scriptName, statusMessage) {
  const hook = { type: 'command', command: hookCommand(scriptName) };
  if (statusMessage) hook.statusMessage = statusMessage;
  const group = matcher ? { matcher, hooks: [hook] } : { hooks: [hook] };
  return { hooks: { [event]: [group] } };
}

export function scriptPermission(scriptName) {
  return `Bash(node .claude/scripts/${scriptName}:*)`;
}
